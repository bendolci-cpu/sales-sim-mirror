"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AudioDeviceSelector from '@/components/AudioDeviceSelector';
import { audioManager } from '@/lib/audio';
import { mic } from '@/lib/mic';

export default function TestAudioPage() {
  const router = useRouter();
  const [micLevel, setMicLevel] = useState<number>(0);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [testResults, setTestResults] = useState<string[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  const addResult = (result: string) => {
    setTestResults(prev => [...prev, `${new Date().toLocaleTimeString()}: ${result}`]);
  };

  const testMicrophone = async () => {
    setIsTestingMic(true);
    addResult('Starting microphone test...');
    
    try {
      // Get microphone stream
      const stream = await mic.start();
      setMicStream(stream);
      
      if (stream) {
        addResult('✅ Microphone access granted');
        
        // Test levels for 3 seconds
        const level = await audioManager.testMicrophoneLevels(stream);
        setMicLevel(level);
        
        if (level > 50) {
          addResult(`✅ Good microphone levels: ${level}`);
        } else if (level > 10) {
          addResult(`⚠️ Low microphone levels: ${level} - try speaking louder`);
        } else {
          addResult(`❌ Very low microphone levels: ${level} - check microphone connection`);
        }
      } else {
        addResult('❌ Failed to get microphone stream');
      }
    } catch (error) {
      addResult(`❌ Microphone test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsTestingMic(false);
    }
  };

  const testAudioOutput = async () => {
    addResult('Testing audio output...');
    
    try {
      // Create a test tone
      const audioContext = await audioManager.getAudioContext();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 1);
      
      addResult('🔊 Playing test tone - you should hear a beep');
    } catch (error) {
      addResult(`❌ Audio output test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    router.push('/session?mode=challenge&mock=1&scenario=ed-turnover-high-touch');
  };

  const testBargeIn = async () => {
    addResult('Testing barge-in functionality...');
    addResult('Starting a mock call to test barge-in...');
    
    // Start a mock call with barge-in enabled and Fast Refresh disabled for better testing
    router.push('/session?mode=challenge&mock=1&scenario=ed-turnover-high-touch&test_barge_in=1&disableFastRefresh=1');
  };

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
      }
      mic.stop();
      
      // Clean up audio manager
      try {
        audioManager.cleanup();
      } catch (e) {
        console.warn('[TestAudio] Failed to clean up audio manager:', e);
      }
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
                  className="w-full px-4 py-2 bg-orange-500 text-white rounded-md hover:bg-orange-600"
                >
                  Test Barge-In
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
