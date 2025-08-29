"use client";

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function TestBargeInPage() {
  const router = useRouter();

  useEffect(() => {
    // Disable Fast Refresh for this page
    if (typeof window !== 'undefined') {
      // Add a flag to disable Fast Refresh warnings
      (window as any).__DISABLE_FAST_REFRESH_WARNINGS = true;
    }
  }, []);

  const startTest = () => {
    // Navigate to session with barge-in testing parameters
    router.push('/session?mode=challenge&mock=1&scenario=ed-turnover-high-touch&test_barge_in=1&disableFastRefresh=1');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6 text-center">
          Barge-In Test
        </h1>
        
        <div className="space-y-4 mb-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h2 className="font-semibold text-blue-900 mb-2">Test Instructions:</h2>
            <ol className="text-sm text-blue-800 space-y-2 list-decimal list-inside">
              <li>Click "Start Test" to begin a mock call</li>
              <li>Wait for the AI to start speaking</li>
              <li>Try interrupting by speaking loudly</li>
              <li>The AI should stop immediately when you speak</li>
              <li>Test multiple times to verify consistency</li>
            </ol>
          </div>
          
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h2 className="font-semibold text-yellow-900 mb-2">Expected Behavior:</h2>
            <ul className="text-sm text-yellow-800 space-y-2 list-disc list-inside">
              <li>AI stops within 30ms of you speaking</li>
              <li>Works with normal speaking volume</li>
              <li>Works consistently across multiple tests</li>
              <li>No "Mic analyzer not available" errors</li>
            </ul>
          </div>
          
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <h2 className="font-semibold text-green-900 mb-2">Optimizations Applied:</h2>
            <ul className="text-sm text-green-800 space-y-2 list-disc list-inside">
              <li>Ultra-aggressive detection (micRMS > 35)</li>
              <li>Super-aggressive fallback (micRMS > 25)</li>
              <li>Dev-mode detection (micRMS > 20)</li>
              <li>100fps monitoring frequency</li>
              <li>Aggressive audio cleanup</li>
            </ul>
          </div>
        </div>
        
        <button
          onClick={startTest}
          className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
        >
          Start Barge-In Test
        </button>
        
        <div className="mt-4 text-center">
          <p className="text-sm text-gray-600">
            This test disables Fast Refresh warnings and uses aggressive barge-in detection
          </p>
        </div>
      </div>
    </div>
  );
}
