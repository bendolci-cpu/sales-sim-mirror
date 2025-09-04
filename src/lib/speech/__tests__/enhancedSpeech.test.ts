import { createEnhancedSpeech } from '../enhancedSpeech';

// Mock the Web Speech API
const mockSpeechRecognition = {
  continuous: false,
  interimResults: false,
  maxAlternatives: 1,
  grammars: null,
  onstart: null as (() => void) | null,
  onend: null as (() => void) | null,
  onerror: null as ((event: any) => void) | null,
  onresult: null as ((event: any) => void) | null,
  start: jest.fn(),
  stop: jest.fn(),
};

// Mock window object
Object.defineProperty(window, 'webkitSpeechRecognition', {
  value: jest.fn(() => mockSpeechRecognition),
  writable: true,
});

Object.defineProperty(window, 'SpeechRecognition', {
  value: jest.fn(() => mockSpeechRecognition),
  writable: true,
});

describe('EnhancedSpeech ASR Guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock instance
    mockSpeechRecognition.start.mockClear();
    mockSpeechRecognition.stop.mockClear();
  });

  it('should prevent double-start errors', () => {
    const handlers = {
      onInterim: jest.fn(),
      onFinal: jest.fn(),
      onSpeechStart: jest.fn(),
      onSpeechEnd: jest.fn(),
    };

    const speech = createEnhancedSpeech(handlers);
    expect(speech).toBeTruthy();

    // First start should work
    speech?.start();
    expect(mockSpeechRecognition.start).toHaveBeenCalledTimes(1);

    // Second start should be no-op (already running)
    speech?.start();
    expect(mockSpeechRecognition.start).toHaveBeenCalledTimes(1);

    // Verify isRunning returns true
    expect(speech?.isRunning()).toBe(true);
  });

  it('should handle InvalidStateError gracefully', () => {
    const handlers = {
      onInterim: jest.fn(),
      onFinal: jest.fn(),
      onSpeechStart: jest.fn(),
      onSpeechEnd: jest.fn(),
    };

    const speech = createEnhancedSpeech(handlers);
    expect(speech).toBeTruthy();

    // Mock InvalidStateError on start
    const invalidStateError = new Error('InvalidStateError');
    invalidStateError.name = 'InvalidStateError';
    mockSpeechRecognition.start.mockImplementation(() => {
      throw invalidStateError;
    });

    // Should not throw, should handle gracefully
    expect(() => speech?.start()).not.toThrow();
  });

  it('should auto-restart when not during TTS', () => {
    const handlers = {
      onInterim: jest.fn(),
      onFinal: jest.fn(),
      onSpeechStart: jest.fn(),
      onSpeechEnd: jest.fn(),
    };

    const speech = createEnhancedSpeech(handlers);
    expect(speech).toBeTruthy();

    // Start recognition
    speech?.start();
    expect(mockSpeechRecognition.start).toHaveBeenCalledTimes(1);

    // Simulate recognition ending
    if (mockSpeechRecognition.onend) {
      mockSpeechRecognition.onend();
    }

    // Should auto-restart after a delay
    jest.advanceTimersByTime(150);
    expect(mockSpeechRecognition.start).toHaveBeenCalledTimes(2);
  });

  it('should not auto-restart during TTS', () => {
    const handlers = {
      onInterim: jest.fn(),
      onFinal: jest.fn(),
      onSpeechStart: jest.fn(),
      onSpeechEnd: jest.fn(),
    };

    const speech = createEnhancedSpeech(handlers);
    expect(speech).toBeTruthy();

    // Start recognition
    speech?.start();
    expect(mockSpeechRecognition.start).toHaveBeenCalledTimes(1);

    // Set TTS playing
    speech?.setTTSPlaying(true);

    // Simulate recognition ending
    if (mockSpeechRecognition.onend) {
      mockSpeechRecognition.onend();
    }

    // Should NOT auto-restart during TTS
    jest.advanceTimersByTime(150);
    expect(mockSpeechRecognition.start).toHaveBeenCalledTimes(1);
  });
});
