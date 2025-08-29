// Unified message dispatcher for both text and voice input
import { logInfo, logError, logWarn } from './logger';

export interface MessageMetadata {
  source: 'voice' | 'text';
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
  async sendMessage(text: string, metadata: Omit<MessageMetadata, 'timestamp'>): Promise<MessageResponse | null> {
    const request: MessageRequest = {
      text: text.trim(),
      metadata: {
        ...metadata,
        timestamp: Date.now()
      }
    };

    if (!request.text) {
      logWarn('[MessageDispatcher] Empty message, ignoring');
      return null;
    }

    const messageId = crypto.randomUUID();
    logInfo('[Speech→AI] Sent utterance', { 
      id: messageId, 
      text: request.text.slice(0, 60) + (request.text.length > 60 ? '...' : ''),
      source: metadata.source,
      confidence: metadata.confidence
    });

    // If not connected, queue the message
    if (!this.isConnected) {
      this.messageQueue.push(request);
      logWarn('[MessageDispatcher] Not connected, queuing message', { queueLength: this.messageQueue.length });
      return null;
    }

    return this.processMessage(request, messageId);
  }

  // Process a single message with retry logic
  private async processMessage(request: MessageRequest, messageId: string): Promise<MessageResponse> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Try all handlers
        for (const handler of this.handlers) {
          try {
            const response = await handler(request);
            if (response.success) {
              logInfo('[AI→Chat] Received response', { 
                id: messageId, 
                len: response.text.length,
                responseId: response.id 
              });
              return response;
            }
          } catch (handlerError) {
            logError('[MessageDispatcher] Handler error', { 
              handler: handler.name || 'anonymous',
              error: handlerError instanceof Error ? handlerError.message : 'Unknown error'
            });
          }
        }

        // If we get here, no handler succeeded
        throw new Error('No handler processed the message successfully');

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        if (attempt < this.maxRetries) {
          this.retryCount++;
          const delay = this.retryDelay * Math.pow(2, attempt); // Exponential backoff
          logWarn('[AI Transport] Error, will retry', { 
            attempt: attempt + 1, 
            maxRetries: this.maxRetries,
            delay,
            error: errorMessage 
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logError('[AI Transport] Error, max retries exceeded', { 
            attempts: attempt + 1,
            error: errorMessage 
          });
          return {
            id: messageId,
            text: '',
            success: false,
            error: errorMessage
          };
        }
      }
    }

    // This should never be reached, but TypeScript requires it
    return {
      id: messageId,
      text: '',
      success: false,
      error: 'Unexpected error in message processing'
    };
  }

  // Process queued messages
  private async processQueue() {
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    
    for (const request of queue) {
      try {
        await this.processMessage(request, crypto.randomUUID());
      } catch (error) {
        logError('[MessageDispatcher] Failed to process queued message', { error });
        // Re-queue failed messages
        this.messageQueue.push(request);
      }
    }
  }

  // Get queue status
  getQueueStatus() {
    return {
      queueLength: this.messageQueue.length,
      isConnected: this.isConnected,
      retryCount: this.retryCount
    };
  }

  // Clear queue
  clearQueue() {
    const length = this.messageQueue.length;
    this.messageQueue = [];
    logInfo('[MessageDispatcher] Cleared message queue', { clearedCount: length });
  }
}

// Export singleton instance
export const messageDispatcher = new MessageDispatcher();

// Export convenience functions
export const sendMessage = (text: string, metadata: Omit<MessageMetadata, 'timestamp'>) => 
  messageDispatcher.sendMessage(text, metadata);

export const registerMessageHandler = (handler: MessageHandler) => 
  messageDispatcher.registerHandler(handler);

export const unregisterMessageHandler = (handler: MessageHandler) => 
  messageDispatcher.unregisterHandler(handler);

export const setMessageDispatcherConnected = (connected: boolean) => 
  messageDispatcher.setConnected(connected);
