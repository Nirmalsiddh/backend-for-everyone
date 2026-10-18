import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
export const platformPassword = 'platform-e2e-password-12345';
export async function signupLogin(page: Page) {
  const email = `platform-${randomUUID()}@example.test`;
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(platformPassword);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Continue to sign in');
  await login(page, email);
  return email;
}
export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(platformPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
}
