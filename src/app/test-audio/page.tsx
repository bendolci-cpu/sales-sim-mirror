"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AudioDeviceSelector from '@/components/AudioDeviceSelector';
import { getTestPipeline, getCurrentPipeline, cleanupUnifiedAudioPipeline, isTestPipeline } from '@/lib/unifiedAudioPipeline';

export default function TestAudioPage() {
  const router = useRouter();
  const [micLevel, setMicLevel] = useState<number>(0);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [isTestingBargeIn, setIsTestingBargeIn] = useState(false);
  const [testResults, setTestResults] = useState<string[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [isPipelineReset, setIsPipelineReset] = useState(false);

  const addResult = (result: string) => {
    setTestResults(prev => [...prev, `${new Date().toLocaleTimeString()}: ${result}`]);
  };

  const resetPipeline = () => {
    setIsPipelineReset(true);
    addResult('🔄 Resetting audio pipeline...');
    
    try {
      // Force cleanup of current pipeline
      cleanupUnifiedAudioPipeline();
      addResult('✅ Pipeline reset complete');
      
      // Clear any local state
      setMicStream(null);
      setMicLevel(0);
      setIsTestingMic(false);
      setIsTestingBargeIn(false);
      
      setTimeout(() => setIsPipelineReset(false), 1000);
    } catch (error) {
      addResult(`❌ Pipeline reset failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsPipelineReset(false);
    }
  };

  const testMicrophone = async () => {
    setIsTestingMic(true);
    addResult('Starting microphone test...');
    
    let localAudioContext: AudioContext | null = null;
    
    try {
      // Get microphone stream directly
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      
      if (stream) {
        addResult('✅ Microphone access granted');
        
        // Test levels for 3 seconds
        const pipeline = getCurrentPipeline();
        const audioContext = pipeline ? pipeline.getOrCreateAudioContext() : new AudioContext();
        if (!pipeline) {
          localAudioContext = audioContext;
        }
        const source = audioContext.createMediaStreamSource(stream);
        const analyzer = audioContext.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);
        
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        let maxLevel = 0;
        
        const testDuration = 3000; // 3 seconds
        const startTime = Date.now();
        
        const checkLevels = () => {
          analyzer.getByteFrequencyData(dataArray);
          const currentLevel = Math.max(...dataArray);
          maxLevel = Math.max(maxLevel, currentLevel);
          
          if (Date.now() - startTime < testDuration) {
            requestAnimationFrame(checkLevels);
          } else {
            // Stop the stream and cleanup
            stream.getTracks().forEach(track => track.stop());
            // Only close AudioContext if we created our own (not from pipeline)
            if (localAudioContext) {
              localAudioContext.close();
            }
            setMicLevel(maxLevel);
            
            if (maxLevel > 50) {
              addResult(`✅ Good microphone levels: ${maxLevel}`);
            } else if (maxLevel > 10) {
              addResult(`⚠️ Low microphone levels: ${maxLevel} - try speaking louder`);
            } else {
              addResult(`❌ Very low microphone levels: ${maxLevel} - check microphone connection`);
            }
            setIsTestingMic(false);
          }
        };
        
        checkLevels();
        addResult('🎤 Testing microphone levels... Please speak for 3 seconds');
      } else {
        addResult('❌ Failed to get microphone stream');
        setIsTestingMic(false);
      }
    } catch (error) {
      addResult(`❌ Microphone test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsTestingMic(false);
    }
  };

  const testAudioOutput = async () => {
    addResult('Testing audio output...');
    
    let localAudioContext: AudioContext | null = null;
    
    try {
      // Use shared AudioContext from UnifiedAudioPipeline
      const pipeline = getCurrentPipeline();
      const audioContext = pipeline ? pipeline.getOrCreateAudioContext() : new AudioContext();
      if (!pipeline) {
        localAudioContext = audioContext;
      }
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 1);
      
      addResult('🔊 Playing test tone - you should hear a beep');
      
      // Cleanup after tone
      setTimeout(() => {
        // Only close AudioContext if we created our own (not from pipeline)
        if (localAudioContext) {
          localAudioContext.close();
        }
      }, 1500);
    } catch (error) {
      addResult(`❌ Audio output test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const testBargeIn = async () => {
    if (isTestingBargeIn) return;
    
    setIsTestingBargeIn(true);
    addResult('🎯 Starting barge-in test...');
    addResult('📢 Playing TTS - try speaking to interrupt it!');
    
    let pipeline = null;
    
    try {
      // Get or create a test pipeline
      pipeline = getTestPipeline({
        onBargeIn: () => {
          addResult('🎉 BARGED-IN SUCCESSFULLY! TTS was interrupted by your voice.');
          setIsTestingBargeIn(false);
        },
        onTTSEnd: () => {
          addResult('🔚 TTS finished naturally (no barge-in detected)');
          setIsTestingBargeIn(false);
        },
        onTTSError: (error) => {
          addResult(`❌ TTS error: ${error.message}`);
          setIsTestingBargeIn(false);
        },
        onError: (error) => {
          addResult(`❌ Pipeline error: ${error.message}`);
          setIsTestingBargeIn(false);
        }
      });
      
      // Initialize the pipeline if needed
      if (!pipeline.isInitialized()) {
        await pipeline.initialize();
        addResult('✅ Pipeline initialized');
      }
      
      // Ensure mic track is ready
      const micTrack = await pipeline.ensureMicTrack();
      if (micTrack) {
        addResult('✅ Microphone ready for barge-in detection');
      }
      
      // Play TTS with a test string
      const testText = "This is a test of the barge-in functionality. I will keep talking for about ten seconds so you can try to interrupt me by speaking. The barge-in detection should pause this audio when you speak loudly enough. Try saying something now to test the interruption.";
      
      await pipeline.playTTS(testText, 'barge-in-test');
      addResult('🎵 TTS playback started - speak now to test barge-in!');
      
    } catch (error) {
      addResult(`❌ Barge-in test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsTestingBargeIn(false);
    } finally {
      // Clean up test pipeline if it was created for testing
      if (pipeline && isTestPipeline()) {
        addResult('🧹 Cleaning up test pipeline...');
        try {
          pipeline.forceCleanup();
          addResult('✅ Test pipeline cleaned up');
        } catch (cleanupError) {
          addResult(`⚠️ Pipeline cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`);
        }
      }
    }
  };

  const runFullTest = async () => {
    setTestResults([]);
    addResult('Starting full audio test...');
    
    // Test microphone
    await testMicrophone();
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test audio output
    await testAudioOutput();
    
    addResult('Full test complete!');
  };

  const startCall = () => {
    router.push('/session?mode=challenge&scenario=ed-turnover-high-touch');
  };

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
      }
      
      // Don't close shared AudioContext from pipeline
      // Only clean up if we created our own contexts
    };
  }, [micStream]);

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Audio Test</h1>
          <p className="text-gray-600">
            Test your microphone and speakers before starting a call
          </p>
          {process.env.NODE_ENV === 'development' && (
            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
              <p className="text-sm text-yellow-800">
                <strong>Development Mode:</strong> Fast Refresh may interrupt barge-in detection. 
                If barge-in doesn't work consistently, try:
              </p>
              <ul className="text-sm text-yellow-800 mt-2 list-disc list-inside">
                <li>Refreshing the page manually</li>
                <li>Restarting the dev server</li>
                <li>Adding <code className="bg-yellow-100 px-1 rounded">?disableFastRefresh=1</code> to the URL</li>
              </ul>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Audio Device Settings */}
          <div>
            <AudioDeviceSelector />
          </div>

          {/* Test Controls */}
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h3 className="text-lg font-semibold mb-4">Quick Tests</h3>
              
              <div className="space-y-3">
                <button
                  onClick={testMicrophone}
                  disabled={isTestingMic}
                  className="w-full px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
                >
                  {isTestingMic ? 'Testing...' : 'Test Microphone'}
                </button>
                
                <button
                  onClick={testAudioOutput}
                  className="w-full px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600"
                >
                  Test Audio Output
                </button>
                
                <button
                  onClick={runFullTest}
                  className="w-full px-4 py-2 bg-purple-500 text-white rounded-md hover:bg-purple-600"
                >
                  Run Full Test
                </button>
                
                <button
                  onClick={testBargeIn}
                  disabled={isTestingBargeIn}
                  className="w-full px-4 py-2 bg-orange-500 text-white rounded-md hover:bg-orange-600 disabled:opacity-50"
                >
                  {isTestingBargeIn ? 'Testing Barge-In...' : 'Test Barge-In'}
                </button>
                
                <button
                  onClick={resetPipeline}
                  disabled={isPipelineReset}
                  className="w-full px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 disabled:opacity-50"
                >
                  {isPipelineReset ? 'Resetting...' : 'Reset Pipeline'}
                </button>
              </div>

              {/* Microphone Level Indicator */}
              {micLevel > 0 && (
                <div className="mt-4">
                  <div className="text-sm text-gray-600 mb-2">Microphone Level:</div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className={`h-2 rounded-full transition-all duration-200 ${
                        micLevel > 50 ? 'bg-green-500' : 
                        micLevel > 10 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${Math.min(100, (micLevel / 100) * 100)}%` }}
                    />
                  </div>
                  <div className="text-xs text-gray-500 mt-1">{micLevel}</div>
                </div>
              )}
            </div>

            {/* Start Call Button */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h3 className="text-lg font-semibold mb-4">Ready to Start?</h3>
              <button
                onClick={startCall}
                className="w-full px-4 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
              >
                Start Challenge Call
              </button>
            </div>
          </div>
        </div>

        {/* Test Results */}
        {testResults.length > 0 && (
          <div className="mt-8 bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-lg font-semibold mb-4">Test Results</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {testResults.map((result, index) => (
                <div key={index} className="text-sm text-gray-700 font-mono">
                  {result}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
