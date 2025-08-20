"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="rounded-lg border border-gray-200 bg-white px-6 py-4 text-center shadow">
        <h1 className="text-lg font-semibold text-gray-900">Page not found</h1>
        <p className="mt-1 text-sm text-gray-600">The page you are looking for does not exist.</p>
        <div className="mt-4">
          <Link href="/" className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700">
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}


