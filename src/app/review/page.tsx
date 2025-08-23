export const dynamic = "force-dynamic";
export const revalidate = 0;

import ReviewClient from "@/app/review/ReviewClient";

export default async function ReviewPage({ searchParams }: { searchParams: { id?: string } }) {
  const id = searchParams?.id ?? "";
  return <ReviewClient reviewId={id} />;
}

