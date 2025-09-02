import type { Meta, StoryObj } from '@storybook/react';
import { SignalBadge } from './SignalBadge';

const meta: Meta<typeof SignalBadge> = {
  title: 'Components/SignalBadge',
  component: SignalBadge,
  args: { signal: 'buy' }
};
export default meta;
type Story = StoryObj<typeof SignalBadge>;
export const Buy: Story = { args: { signal: 'buy' } };
export const Hold: Story = { args: { signal: 'hold' } };
export const Sell: Story = { args: { signal: 'sell' } };