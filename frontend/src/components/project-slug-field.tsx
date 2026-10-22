'use client';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { ApiError } from '@/lib/api';

export function isProjectSlugConflict(error: unknown) {
  return error instanceof ApiError && error.code === 'SLUG_UNAVAILABLE';
}

export function ProjectSlugField({
  registration,
  error,
}: {
  registration: UseFormRegisterReturn<'slug'>;
  error: unknown;
}) {
  const conflict = isProjectSlugConflict(error);
  return (
    <label>
      Slug
      <input
        {...registration}
        aria-label="Slug"
        autoComplete="off"
        aria-describedby={conflict ? 'project-slug-help project-slug-error' : 'project-slug-help'}
        aria-invalid={conflict || undefined}
        required
        pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
        minLength={3}
        maxLength={63}
      />
      <small id="project-slug-help">Project names can repeat. The API slug must be unique across the platform.</small>
      {conflict && (
        <span id="project-slug-error" className="error" role="alert">
          That API slug is already taken. Choose another slug.
        </span>
      )}
    </label>
  );
}
