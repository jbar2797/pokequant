import type { Meta, StoryObj } from '@storybook/react';
import { Skeleton, EmptyState, InlineError } from './Feedback';

const meta: Meta = { title: 'Components/Feedback' } as Meta;
export default meta;

export const LoadingList: StoryObj = {
  render: () => <Skeleton lines={3} className="w-64" />
};
export const Empty: StoryObj = {
  render: () => <EmptyState title="No Data" description="Try adjusting filters." />
};
export const ErrorInline: StoryObj = {
  render: () => <InlineError message="Something went wrong" />
};