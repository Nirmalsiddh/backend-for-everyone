'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api } from '@/lib/api';
import type { Project } from '@/lib/contracts';
import {
  useData,
  useAction,
  ActionState,
  State,
  DirtyGuard,
} from '@/components/ui';
const input = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
});
export default function Projects() {
  const [offset, setOffset] = useState(0);
  const query = useData<{ items: Project[]; nextOffset: number | null }>(
    `projects?limit=20&offset=${offset}`,
  );
  const action = useAction({
    refresh: [`projects?limit=20&offset=${offset}`],
    success: 'Project created',
  });
  const router = useRouter();
  const [slugEdited, setSlugEdited] = useState(false);
  const { register, handleSubmit, watch, setValue, formState, reset } =
    useForm<{ name: string; slug: string }>();
  const name = watch('name') ?? '';
  useEffect(() => {
    if (!slugEdited)
      setValue(
        'slug',
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .replace(/^[^a-z]+/, '')
          .slice(0, 63),
      );
  }, [name, slugEdited, setValue]);
  return (
    <main className="projects-page">
      <h1>Projects</h1>
      <p className="muted">Create and manage your backend projects.</p>
      <section className="project-create">
        <h2>Create project</h2>
        <DirtyGuard dirty={formState.isDirty} />
        <form
          onSubmit={handleSubmit((v) =>
            action.run(
              () => api<Project>('projects', 'POST', input.parse(v)),
              (p) => {
                reset();
                router.push(`/projects/${p.id}`);
              },
            ),
          )}
        >
          <div className="row">
            <label>
              Name
              <input {...register('name')} required maxLength={100} />
            </label>
            <label>
              Slug
              <input
                {...register('slug', { onChange: () => setSlugEdited(true) })}
                required
                pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
                minLength={3}
                maxLength={63}
              />
            </label>
          </div>
          <button disabled={action.busy}>Create project</button>
        </form>
        <ActionState action={action} />
      </section>
      <h2 className="project-list-heading">Your projects</h2>
      <State query={query}>
        {query.data?.items.length === 0 ? (
          <p className="empty-state">
            Create your first project, connect PostgreSQL, then build an API.
          </p>
        ) : (
          <ul className="project-list">
            {query.data?.items.map((p) => (
              <li key={p.id}>
                <Link className="project-item" href={`/projects/${p.id}`} aria-labelledby={`project-name-${p.id}`}>
                  <span className="project-item-copy">
                    <span className="project-item-name" id={`project-name-${p.id}`}>{p.name}</span>
                    <span className="project-item-slug">Slug: <code>{p.slug}</code></span>
                  </span>
                  <span className="project-item-action" aria-hidden="true">Open project <span>→</span></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="project-pagination">
        <button
          className="secondary"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous
        </button>
        <button
          disabled={query.data?.nextOffset == null}
          onClick={() => setOffset(query.data!.nextOffset!)}
        >
          Next
        </button>
        </div>
      </State>
    </main>
  );
}
