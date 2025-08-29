"use client";

import { useState, useEffect, useRef } from 'react';

export default function TestMicPage() {
  const [micLevel, setMicLevel] = useState<number>(0);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [micStatus, setMicStatus] = useState<string>('Not started');
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startMicTest = async () => {
    try {
      setMicStatus('Requesting microphone permission...');
      
      // Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        } 
      });
      
      streamRef.current = stream;
      setMicStatus('Microphone permission granted');

      // Create audio context
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      
      // Create analyzer
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 256;
      analyzer.smoothingTimeConstant = 0.8;
      analyzerRef.current = analyzer;
      
      // Create source and connect
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      source.connect(analyzer);
      
      setMicStatus('Microphone test started');
      setIsListening(true);
      
      // Start monitoring
      const monitorMic = () => {
        if (!isListening) return;
        
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        
        setMicLevel(rms);
        requestAnimationFrame(monitorMic);
      };
      
      monitorMic();
      
    } catch (error) {
      console.error('Microphone test failed:', error);
      setMicStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const stopMicTest = () => {
    setIsListening(false);
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    
    if (analyzerRef.current) {
      analyzerRef.current.disconnect();
      analyzerRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    setMicLevel(0);
    setMicStatus('Microphone test stopped');
  };

  useEffect(() => {
    return () => {
      stopMicTest();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6 text-center">
          Microphone Test
        </h1>
        
        <div className="space-y-4 mb-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h2 className="font-semibold text-blue-900 mb-2">Status:</h2>
            <p className="text-sm text-blue-800">{micStatus}</p>
          </div>
          
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <h2 className="font-semibold text-green-900 mb-2">Microphone Level:</h2>
            <div className="flex items-center space-x-4">
              <div className="flex-1 bg-gray-200 rounded-full h-4">
                <div 
                  className="bg-green-500 h-4 rounded-full transition-all duration-100"
                  style={{ width: `${Math.min((micLevel / 255) * 100, 100)}%` }}
                ></div>
              </div>
              <span className="text-sm font-mono text-green-800">
                {micLevel.toFixed(1)}
              </span>
            </div>
          </div>
          
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h2 className="font-semibold text-yellow-900 mb-2">Expected Levels:</h2>
            <ul className="text-sm text-yellow-800 space-y-1">
              <li>• Background noise: 10-25</li>
              <li>• Normal speech: 30-60</li>
              <li>• Loud speech: 60-100</li>
              <li>• Very loud: 100+</li>
            </ul>
          </div>
        </div>
        
        <div className="space-y-3">
          {!isListening ? (
            <button
              onClick={startMicTest}
              className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
            >
              Start Microphone Test
            </button>
          ) : (
            <button
              onClick={stopMicTest}
              className="w-full bg-red-600 text-white py-3 px-4 rounded-lg hover:bg-red-700 transition-colors font-semibold"
            >
              Stop Microphone Test
            </button>
          )}
          
          <button
            onClick={() => window.history.back()}
            className="w-full bg-gray-600 text-white py-3 px-4 rounded-lg hover:bg-gray-700 transition-colors font-semibold"
          >
            Back to Session
          </button>
        </div>
        
        <div className="mt-4 text-center">
          <p className="text-sm text-gray-600">
            Speak into your microphone and watch the level indicator
          </p>
        </div>
      </div>
    </div>
  );
}
