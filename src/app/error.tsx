"use client";

export default function Error() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="rounded-lg border border-red-200 bg-white px-6 py-4 text-center shadow">
        <h1 className="text-lg font-semibold text-red-700">Something went wrong</h1>
        <p className="mt-1 text-sm text-gray-600">Please try again or go back.</p>
      </div>
    </main>
  );
}


