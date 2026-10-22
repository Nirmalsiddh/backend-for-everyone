'use client';
import { useParams } from 'next/navigation';
import { GuidedBuilder } from '@/components/guided-builder';

export default function GuidedPage() {
  const { id } = useParams<{ id: string }>();
  return <GuidedBuilder key={id} projectId={id} />;
}
