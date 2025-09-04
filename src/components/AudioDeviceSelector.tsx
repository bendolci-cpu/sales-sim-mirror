"use client";

import React, { useState, useEffect } from 'react';
import { getCurrentPipeline } from '@/lib/unifiedAudioPipeline';

interface AudioDevice {
  deviceId: string;
  label: string;
  groupId?: string;
}

export default function AudioDeviceSelector() {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>('');
  const [selectedOutput, setSelectedOutput] = useState<string>('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const [outputDeviceError, setOutputDeviceError] = useState<string>('');

  useEffect(() => {
    loadDevices();
  }, []);

  const loadDevices = async () => {
    try {
      // Use navigator.mediaDevices directly
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      const inputs = devices
        .filter(device => device.kind === 'audioinput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          groupId: device.groupId
        }));
      
      const outputs = devices
        .filter(device => device.kind === 'audiooutput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Speaker ${device.deviceId.slice(0, 8)}`,
          groupId: device.groupId
        }));
      
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

  const handleOutputDeviceChange = async (deviceId: string) => {
    setSelectedOutput(deviceId);
    setOutputDeviceError('');
    
    try {
      const pipeline = getCurrentPipeline();
      if (pipeline) {
        await pipeline.setOutputDevice(deviceId);
        setTestResult(`✅ Output device changed to: ${outputDevices.find(d => d.deviceId === deviceId)?.label || deviceId}`);
      } else {
        // Test with a local audio element if no pipeline exists
        const testAudio = new Audio();
        if (!('setSinkId' in testAudio)) {
          throw new Error('setSinkId not supported in this browser');
        }
        await (testAudio as any).setSinkId(deviceId);
        setTestResult(`✅ Output device changed to: ${outputDevices.find(d => d.deviceId === deviceId)?.label || deviceId}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('setSinkId not supported')) {
        setOutputDeviceError('⚠️ Output device selection not supported in this browser. Use your system audio settings instead.');
      } else {
        setOutputDeviceError(`❌ Failed to change output device: ${errorMessage}`);
      }
      console.error('Failed to change output device:', error);
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
      
      // Use shared AudioContext from UnifiedAudioPipeline
      const pipeline = getCurrentPipeline();
      const audioContext = pipeline ? pipeline.getOrCreateAudioContext() : new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 256;
      
      source.connect(analyzer);
      
      // Test levels for a short duration
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      let maxLevel = 0;
      
      const testDuration = 2000; // 2 seconds
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
          if (!pipeline) {
            audioContext.close();
          }
          
          if (maxLevel > 50) {
            setTestResult(`✅ Good microphone levels: ${maxLevel}`);
          } else if (maxLevel > 10) {
            setTestResult(`⚠️ Low microphone levels: ${maxLevel} - try speaking louder`);
          } else {
            setTestResult(`❌ Very low microphone levels: ${maxLevel} - check microphone connection`);
          }
          setIsTesting(false);
        }
      };
      
      checkLevels();
      setTestResult('🎤 Testing microphone levels... Please speak for 2 seconds');
      
    } catch (error) {
      setTestResult(`❌ Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsTesting(false);
    }
  };

  const testAudioOutput = async () => {
    try {
      // Use shared AudioContext from UnifiedAudioPipeline
      const pipeline = getCurrentPipeline();
      const audioContext = pipeline ? pipeline.getOrCreateAudioContext() : new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 1);
      
      setTestResult('🔊 Playing test tone...');
      setTimeout(() => {
        setTestResult('');
        // Only close AudioContext if we created our own (not from pipeline)
        if (!pipeline) {
          audioContext.close();
        }
      }, 2000);
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
            onChange={(e) => handleOutputDeviceChange(e.target.value)}
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
          {outputDeviceError && (
            <p className="mt-2 text-sm text-red-500">{outputDeviceError}</p>
          )}
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
