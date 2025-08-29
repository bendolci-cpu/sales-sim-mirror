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

class MessageDispatcher {
  private handlers: MessageHandler[] = [];
  private isConnected = false;
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

  // Set connection status
  setConnected(connected: boolean) {
    this.isConnected = connected;
    if (connected && this.messageQueue.length > 0) {
      logInfo('[MessageDispatcher] Connection restored, processing queued messages', { queueLength: this.messageQueue.length });
      this.processQueue();
    }
  }

  // Send a message (main entry point)
  async sendMessage(request: MessageRequest): Promise<MessageResponse | null> {
    if (!request.text || !request.text.trim()) {
      logWarn('[MessageDispatcher] Empty message, ignoring');
      return null;
    }

    const messageId = crypto.randomUUID();
    logInfo('[MessageDispatcher] Processing message', { 
      id: messageId, 
      text: request.text.slice(0, 60) + (request.text.length > 60 ? '...' : ''),
      source: request.metadata.source,
      confidence: request.metadata.confidence
    });

    // If not connected, queue the message
    if (!this.isConnected) {
      this.messageQueue.push(request);
      logWarn('[MessageDispatcher] Not connected, queuing message', { queueLength: this.messageQueue.length });
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
        // Try all handlers
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

  // Get connection status
  isConnected(): boolean {
    return this.isConnected;
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

export function setMessageDispatcherConnected(connected: boolean) {
  messageDispatcher.setConnected(connected);
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
