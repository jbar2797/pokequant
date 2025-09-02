import type { Meta, StoryObj } from '@storybook/react';
import { AppShell } from './AppShell';

const meta: Meta<typeof AppShell> = { title: 'Layout/AppShell', component: AppShell };
export default meta;

type Story = StoryObj<typeof AppShell>;
export const Basic: Story = {
  render: () => (
    <AppShell header={<div className="text-sm font-semibold">PokeQuant</div>} sidebar={<ul className="text-sm space-y-2"><li>Dashboard</li><li>Search</li><li>Portfolio</li></ul>}>
      <p>Content area</p>
    </AppShell>
  )
};