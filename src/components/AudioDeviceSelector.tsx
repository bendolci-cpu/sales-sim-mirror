"use client";

import React, { useState, useEffect } from 'react';
import { audioManager, type AudioDevice, type AudioOutputDevice } from '@/lib/audio';

export default function AudioDeviceSelector() {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>('');
  const [selectedOutput, setSelectedOutput] = useState<string>('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>('');

  useEffect(() => {
    loadDevices();
    
    // Cleanup on unmount
    return () => {
      try {
        audioManager.cleanup();
      } catch (e) {
        console.warn('[AudioDeviceSelector] Failed to clean up audio manager:', e);
      }
    };
  }, []);

  const loadDevices = async () => {
    try {
      const inputs = await audioManager.enumerateInputDevices();
      const outputs = await audioManager.enumerateOutputDevices();
      setInputDevices(inputs);
      setOutputDevices(outputs);
      
      // Auto-select first device if available
      if (inputs.length > 0 && !selectedInput) {
        setSelectedInput(inputs[0].deviceId);
      }
      if (outputs.length > 0 && !selectedOutput) {
        setSelectedOutput(outputs[0].deviceId);
      }
    } catch (error) {
      console.error('Failed to load audio devices:', error);
    }
  };

  const testMicrophone = async () => {
    if (!selectedInput) return;
    
    setIsTesting(true);
    setTestResult('');
    
    try {
      // Get user media with selected device
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedInput } }
      });
      
      // Test levels
      const level = await audioManager.testMicrophoneLevels(stream);
      
      // Stop the stream
      stream.getTracks().forEach(track => track.stop());
      
      if (level > 50) {
        setTestResult(`✅ Good microphone levels: ${level}`);
      } else if (level > 10) {
        setTestResult(`⚠️ Low microphone levels: ${level} - try speaking louder`);
      } else {
        setTestResult(`❌ Very low microphone levels: ${level} - check microphone connection`);
      }
    } catch (error) {
      setTestResult(`❌ Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsTesting(false);
    }
  };

  const testAudioOutput = async () => {
    if (!selectedOutput) return;
    
    try {
      // Create a test audio element with unique ID
      const testEl = await audioManager.createAudioElement(`testOutput_${Date.now()}`, {
        routeToDevice: selectedOutput,
        volume: 0.3
      });
      
      // Create a simple test tone
      const audioContext = await audioManager.getAudioContext();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 1);
      
      setTestResult('🔊 Playing test tone...');
      setTimeout(() => setTestResult(''), 2000);
    } catch (error) {
      setTestResult(`❌ Audio output test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
      <h3 className="text-lg font-semibold mb-4">Audio Device Settings</h3>
      
      <div className="space-y-4">
        {/* Input Devices */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Microphone
          </label>
          <select
            value={selectedInput}
            onChange={(e) => setSelectedInput(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {inputDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <button
            onClick={testMicrophone}
            disabled={isTesting || !selectedInput}
            className="mt-2 px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
          >
            {isTesting ? 'Testing...' : 'Test Microphone'}
          </button>
        </div>

        {/* Output Devices */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Speaker/Headphones
          </label>
          <select
            value={selectedOutput}
            onChange={(e) => setSelectedOutput(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {outputDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <button
            onClick={testAudioOutput}
            disabled={!selectedOutput}
            className="mt-2 px-3 py-1 text-sm bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
          >
            Test Audio Output
          </button>
        </div>

        {/* Test Results */}
        {testResult && (
          <div className="mt-4 p-3 bg-gray-50 rounded-md">
            <p className="text-sm text-gray-700">{testResult}</p>
          </div>
        )}

        {/* Refresh Button */}
        <button
          onClick={loadDevices}
          className="w-full px-3 py-2 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          Refresh Devices
        </button>
      </div>
    </div>
  );
}
