// Unified message dispatcher for both text and voice input
import { logInfo, logError, logWarn } from './logger';
import { setHeld as speechSetHeld, startHoldTimer as speechStartHoldTimer, holdMsFor as speechHoldMsFor } from './speech/enhancedSpeech';

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
  private isRegistered = false;
  private ttsPlaying = false;
  private lastDroppedHash: string | null = null;

  // Register a message handler (idempotent)
  registerHandler(handler: MessageHandler) {
    if (this.isRegistered) {
      logInfo('[Dispatcher] register skipped (already)');
      return;
    }
    this.handlers.push(handler);
    this.isRegistered = true;
    logInfo('[Dispatcher] register (idempotent)', { handlerCount: this.handlers.length });
  }

  // Remove a message handler (idempotent)
  unregisterHandler(handler: MessageHandler) {
    if (!this.isRegistered) {
      logInfo('[Dispatcher] unregister skipped (already)');
      return;
    }
    const index = this.handlers.indexOf(handler);
    if (index > -1) {
      this.handlers.splice(index, 1);
    }
    this.isRegistered = false;
    logInfo('[Dispatcher] unregister (idempotent)', { handlerCount: this.handlers.length });
  }

  // Toggle TTS playing state for dispatcher behavior
  setTtsPlaying(isPlaying: boolean) {
    this.ttsPlaying = isPlaying;
    // Reset per-utterance drop dedupe when state flips
    if (!isPlaying) this.lastDroppedHash = null;
    logInfo(`[Dispatcher] ttsPlaying=${isPlaying}`);
  }

  // Cancel all pending user messages
  cancelPending(reason: string): number {
    const count = this.messageQueue.length + (mutedBuffer ? 1 : 0);
    this.messageQueue = [];
    mutedBuffer = null;
    logInfo(`[Dispatcher] Cancelled ${count} pending: ${reason}`);
    return count;
  }

  // Get current dispatcher phase for ASR gating
  getPhase(): 'tts' | 'inflight' | 'idle' {
    if (this.ttsPlaying) return 'tts';
    if (this.awaitingAI) return 'inflight';
    return 'idle';
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

    // Buffer speech during TTS (no queue) - hold for merge and timed emit
    if (this.ttsPlaying && request.metadata.source === 'speech') {
      const hash = (request.text || '').trim();
      if (hash && hash !== this.lastDroppedHash) {
        try {
          const conf = request.metadata.confidence ?? 0.9;
          const delay = Math.min(speechHoldMsFor?.(request.text) ?? 600, 900);
          speechSetHeld(request.text, conf);
          speechStartHoldTimer(delay);
          logInfo('[Dispatcher] Held msg during TTS len=' + request.text.length);
        } catch {
          logInfo('[Dispatcher] Held msg during TTS (fallback) len=' + request.text.length);
        }
        this.lastDroppedHash = hash;
      }
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
    // On unmute, immediately send the latest buffered message (if any),
    // regardless of connection or awaiting state. The normal send flow
    // will queue it appropriately if needed.
    if (!muted && mutedBuffer) {
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

// Expose TTS state control for the dispatcher
export function setDispatcherTtsPlaying(isPlaying: boolean) {
  (messageDispatcher as any).setTtsPlaying(isPlaying);
}

// Expose cancellation of pending messages (e.g., on barge-in)
export function cancelDispatcherPending(reason: string): number {
  return (messageDispatcher as any).cancelPending(reason);
}

// Expose current dispatcher phase
export function getDispatcherPhase(): 'tts' | 'inflight' | 'idle' {
  return (messageDispatcher as any).getPhase();
}
