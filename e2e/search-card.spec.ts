import { test, expect } from '@playwright/test';

test('search Mew and open card', async ({ page }) => {
  await page.goto('/search?query=mew');
  await expect(page.getByText(/Mew/i).first()).toBeVisible();
  await page.getByText(/Mew/i).first().click();
});