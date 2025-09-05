"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { error } from '@/lib/logger';
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
  const [browserSupportWarning, setBrowserSupportWarning] = useState<string>('');
  const [permissionError, setPermissionError] = useState<string>('');

  // Memoize loadDevices to prevent unnecessary re-renders
  const loadDevices = useCallback(async () => {
    try {
      setPermissionError('');
      
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
      
      // Check if device labels are empty (indicates permission not granted)
      const hasEmptyLabels = inputs.some(device => !device.label || device.label.includes('Microphone')) ||
                            outputs.some(device => !device.label || device.label.includes('Speaker'));
      
      if (hasEmptyLabels) {
        setPermissionError('⚠️ Device labels are empty. Please grant microphone permission and refresh devices.');
      }
      
      // Auto-select first device if available
      if (inputs.length > 0 && !selectedInput) {
        setSelectedInput(inputs[0].deviceId);
      }
      if (outputs.length > 0 && !selectedOutput) {
        setSelectedOutput(outputs[0].deviceId);
      }
    } catch (err) {
      error('AUDIO-DEVICE', 'Failed to load audio devices:', err);
      setPermissionError('❌ Failed to load audio devices. Please check permissions and try again.');
    }
  }, [selectedInput, selectedOutput]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const handleOutputDeviceChange = async (deviceId: string) => {
    setSelectedOutput(deviceId);
    setOutputDeviceError('');
    setBrowserSupportWarning('');
    
    try {
      const pipeline = getCurrentPipeline();
      if (pipeline && pipeline.setOutputDevice) {
        // Use pipeline's setOutputDevice method if available
        await pipeline.setOutputDevice(deviceId);
        setTestResult(`✅ Output device changed to: ${outputDevices.find(d => d.deviceId === deviceId)?.label || deviceId}`);
      } else {
        // Test with a throwaway audio element if no pipeline exists
        const testAudio = new Audio();
        if (!('setSinkId' in testAudio)) {
          // Show one-time browser support warning
          if (!browserSupportWarning) {
            setBrowserSupportWarning('⚠️ Output device selection not supported in this browser. Use your system audio settings instead.');
          }
          throw new Error('setSinkId not supported in this browser');
        }
        
        // Test setSinkId on throwaway element
        await (testAudio as any).setSinkId(deviceId);
        
        // Destroy the test element immediately after confirming support
        testAudio.src = '';
        testAudio.load();
        
        setTestResult(`✅ Output device changed to: ${outputDevices.find(d => d.deviceId === deviceId)?.label || deviceId}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      if (errorMessage.includes('setSinkId not supported')) {
        // Only show warning once
        if (!browserSupportWarning) {
          setBrowserSupportWarning('⚠️ Output device selection not supported in this browser. Use your system audio settings instead.');
        }
      } else {
        setOutputDeviceError(`❌ Failed to change output device: ${errorMessage}`);
      }
      error('AUDIO-DEVICE', 'Failed to change output device:', err);
    }
  };

  const testMicrophone = async () => {
    if (!selectedInput) return;
    
    setIsTesting(true);
    setTestResult('');
    
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyzer: AnalyserNode | null = null;
    let createdOwnContext = false;
    
    try {
      // Get user media with selected device
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedInput } }
      });
      
      // Create local AudioContext ONLY if pipeline is absent
      const pipeline = getCurrentPipeline();
      if (pipeline) {
        // Use pipeline's AudioContext but don't connect to its graph
        audioContext = pipeline.getOrCreateAudioContext();
      } else {
        // Create our own AudioContext for testing
        audioContext = new AudioContext();
        createdOwnContext = true;
      }
      
      source = audioContext.createMediaStreamSource(stream);
      analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 256;
      
      // Connect source to analyzer for testing (NOT to pipeline's destination)
      source.connect(analyzer);
      
      // Test levels for a short duration
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      let maxLevel = 0;
      
      const testDuration = 2000; // 2 seconds
      const startTime = Date.now();
      
      const checkLevels = () => {
        if (!analyzer) return;
        
        analyzer.getByteFrequencyData(dataArray);
        const currentLevel = Math.max(...dataArray);
        maxLevel = Math.max(maxLevel, currentLevel);
        
        if (Date.now() - startTime < testDuration) {
          requestAnimationFrame(checkLevels);
        } else {
          // Cleanup: Stop all MediaStream tracks
          if (stream) {
            stream.getTracks().forEach(track => track.stop());
          }
          
          // Disconnect analyzer from source
          if (source && analyzer) {
            source.disconnect(analyzer);
          }
          
          // Only close AudioContext if we created our own
          if (createdOwnContext && audioContext) {
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
      // Ensure cleanup on error
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (source && analyzer) {
        source.disconnect(analyzer);
      }
      if (createdOwnContext && audioContext) {
        audioContext.close();
      }
      
      setTestResult(`❌ Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsTesting(false);
    }
  };

  const testAudioOutput = async () => {
    let audioContext: AudioContext | null = null;
    let createdOwnContext = false;
    
    try {
      // Use shared AudioContext from UnifiedAudioPipeline
      const pipeline = getCurrentPipeline();
      if (pipeline) {
        audioContext = pipeline.getOrCreateAudioContext();
      } else {
        audioContext = new AudioContext();
        createdOwnContext = true;
      }
      
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
        if (createdOwnContext && audioContext) {
          audioContext.close();
        }
      }, 2000);
    } catch (error) {
      // Ensure cleanup on error
      if (createdOwnContext && audioContext) {
        audioContext.close();
      }
      setTestResult(`❌ Audio output test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
      <h3 className="text-lg font-semibold mb-4">Audio Device Settings</h3>
      
      {/* Permission Error */}
      {permissionError && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
          <p className="text-sm text-yellow-800">{permissionError}</p>
        </div>
      )}
      
      {/* Browser Support Warning */}
      {browserSupportWarning && (
        <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-md">
          <p className="text-sm text-orange-800">{browserSupportWarning}</p>
        </div>
      )}
      
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
