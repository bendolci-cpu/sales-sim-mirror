// Unified message dispatcher for both text and voice input
import { logInfo, logError, logWarn } from './logger';

export interface MessageMetadata {
  source: 'voice' | 'text' | 'speech';
  timestamp: number;
  roomId?: string;
  participantId?: string;
  confidence?: number;
  duration?: number;
  audioUrl?: string;
}

export interface MessageRequest {
  text: string;
  metadata: MessageMetadata;
}

export interface MessageResponse {
  id: string;
  text: string;
  success: boolean;
  error?: string;
}

export type MessageHandler = (request: MessageRequest) => Promise<MessageResponse>;

// Module-level mute flag as specified in requirements
let muted = false;

// Buffer for speech while muted
let mutedBuffer: MessageRequest | null = null;

export function setMuted(v: boolean) { 
  muted = v; 
  logInfo(`[MessageDispatcher] Mute state changed to: ${v}`);
  
  // If unmuted, try to flush any buffered message
  if (!v) {
    flushMutedBufferIfReady();
  }
}

export function isMuted() { 
  return muted; 
}

class MessageDispatcher {
  private handlers: MessageHandler[] = [];
  private connected = false;
  private messageQueue: MessageRequest[] = [];
  private retryCount = 0;
  private maxRetries = 3;
  private retryDelay = 1000; // Start with 1 second
  private awaitingAI = false;

  // Register a message handler
  registerHandler(handler: MessageHandler) {
    this.handlers.push(handler);
    logInfo('[MessageDispatcher] Registered handler', { handlerCount: this.handlers.length });
  }

  // Remove a message handler
  unregisterHandler(handler: MessageHandler) {
    const index = this.handlers.indexOf(handler);
    if (index > -1) {
      this.handlers.splice(index, 1);
      logInfo('[MessageDispatcher] Unregistered handler', { handlerCount: this.handlers.length });
    }
  }

  // Connect the dispatcher (idempotent)
  connect(): void {
    if (this.connected) {
      logInfo('[MessageDispatcher] Already connected, returning early');
      return;
    }
    
    this.connected = true;
    logInfo('[MessageDispatcher] Connected');
    
    // Process any queued messages
    if (this.messageQueue.length > 0) {
      logInfo('[MessageDispatcher] Connection restored, processing queued messages', { queueLength: this.messageQueue.length });
      this.processQueue();
    }
  }

  // Disconnect the dispatcher (idempotent)
  disconnect(): void {
    if (!this.connected) {
      logInfo('[MessageDispatcher] Already disconnected, returning early');
      return;
    }
    
    this.connected = false;
    this.clearQueue();
    logInfo('[MessageDispatcher] Disconnected and queue cleared');
  }

  // Get connection status
  isConnected(): boolean {
    return this.connected;
  }

  // Send a message (main entry point)
  async sendMessage(request: MessageRequest): Promise<MessageResponse | null> {
    if (!request.text || !request.text.trim()) {
      logWarn('[MessageDispatcher] Empty message, ignoring');
      return null;
    }

    // Check if muted - buffer the message instead of dropping
    if (muted) {
      mutedBuffer = request; // Overwrite any previous buffered message
      logInfo('[MessageDispatcher] Message buffered due to mute state', { 
        text: request.text.slice(0, 60) + (request.text.length > 60 ? '...' : ''),
        source: request.metadata.source
      });
      return null;
    }

    const messageId = crypto.randomUUID();
    logInfo('[MessageDispatcher] Processing message', { 
      id: messageId, 
      text: request.text.slice(0, 60) + (request.text.length > 60 ? '...' : ''),
      source: request.metadata.source,
      confidence: request.metadata.confidence
    });

    // If not connected, keep ONLY the most recent message as specified in requirements
    if (!this.connected) {
      const MAX_QUEUE = 1;
      if (this.messageQueue.length >= MAX_QUEUE) {
        // Remove older messages, keep only the latest
        this.messageQueue = [request];
        logInfo('[MessageDispatcher] Connection offline, keeping only latest message', { queueLength: this.messageQueue.length });
      } else {
        this.messageQueue.push(request);
        logInfo('[MessageDispatcher] Connection offline, queuing message', { queueLength: this.messageQueue.length });
      }
      return null;
    }

    // If already awaiting AI response, queue this message
    if (this.awaitingAI) {
      this.messageQueue.push(request);
      logInfo('[MessageDispatcher] Awaiting AI response, queuing message', { queueLength: this.messageQueue.length });
      return null;
    }

    return this.processMessage(request, messageId);
  }

  // Process a single message with retry logic
  private async processMessage(request: MessageRequest, messageId: string): Promise<MessageResponse> {
    this.awaitingAI = true;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Try handlers until one succeeds
        for (const handler of this.handlers) {
          try {
            const response = await handler(request);
            
            if (response.success) {
              logInfo('[MessageDispatcher] Message processed successfully', { 
                id: messageId, 
                responseLength: response.text.length 
              });
              
              // Process any queued messages
              this.awaitingAI = false;
              this.processQueue();
              
              // Also try to flush any buffered message
              this.flushMutedBufferIfReady();
              
              return response;
            } else {
              logWarn('[MessageDispatcher] Handler returned failure', { 
                id: messageId, 
                error: response.error 
              });
            }
          } catch (handlerError) {
            logError('[MessageDispatcher] Handler error', { 
              id: messageId, 
              error: handlerError 
            });
          }
        }
        
        // If we get here, no handler succeeded
        throw new Error('No handler processed the message successfully');
        
      } catch (error) {
        if (attempt === this.maxRetries) {
          logError('[MessageDispatcher] Max retries reached', { 
            id: messageId, 
            error, 
            attempts: attempt + 1 
          });
          
          this.awaitingAI = false;
          this.processQueue();
          
          // Also try to flush any buffered message
          this.flushMutedBufferIfReady();
          
          return {
            id: messageId,
            text: '',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt)));
      }
    }
    
    this.awaitingAI = false;
    return {
      id: messageId,
      text: '',
      success: false,
      error: 'Unexpected error in message processing'
    };
  }

  // Process queued messages
  private async processQueue() {
    if (this.messageQueue.length === 0 || this.awaitingAI) {
      return;
    }

    const request = this.messageQueue.shift();
    if (request) {
      logInfo('[MessageDispatcher] Processing queued message', { 
        queueLength: this.messageQueue.length 
      });
      await this.sendMessage(request);
    }
  }

  // Get queue length
  getQueueLength(): number {
    return this.messageQueue.length;
  }

  // Get awaiting AI status
  isAwaitingAI(): boolean {
    return this.awaitingAI;
  }

  // Clear queue
  clearQueue() {
    this.messageQueue = [];
    logInfo('[MessageDispatcher] Queue cleared');
  }

  // Flush muted buffer if ready
  flushMutedBufferIfReady() {
    if (!muted && this.connected && !this.awaitingAI && mutedBuffer) {
      const bufferedRequest = mutedBuffer;
      mutedBuffer = null;
      logInfo('[MessageDispatcher] Flushing buffered message', { 
        text: bufferedRequest.text.slice(0, 60) + (bufferedRequest.text.length > 60 ? '...' : ''),
        source: bufferedRequest.metadata.source
      });
      this.sendMessage(bufferedRequest);
    }
  }
}

// Singleton instance
const messageDispatcher = new MessageDispatcher();

// Export functions
export function registerMessageHandler(handler: MessageHandler) {
  messageDispatcher.registerHandler(handler);
}

export function unregisterMessageHandler(handler: MessageHandler) {
  messageDispatcher.unregisterHandler(handler);
}

export function sendMessage(request: MessageRequest): Promise<MessageResponse | null> {
  return messageDispatcher.sendMessage(request);
}

export function connectMessageDispatcher() {
  messageDispatcher.connect();
}

export function disconnectMessageDispatcher() {
  messageDispatcher.disconnect();
}

export function isMessageDispatcherConnected(): boolean {
  return messageDispatcher.isConnected();
}

export function getMessageQueueLength(): number {
  return messageDispatcher.getQueueLength();
}

export function isAwaitingAI(): boolean {
  return messageDispatcher.isAwaitingAI();
}

export function clearMessageQueue() {
  messageDispatcher.clearQueue();
}

export function flushMutedBufferIfReady() {
  messageDispatcher.flushMutedBufferIfReady();
}
