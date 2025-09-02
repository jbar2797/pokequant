import type { Meta, StoryObj } from '@storybook/react';
import { Button, MetricCard, Sparkline, Tabs, SegmentedControl, FactorBreakdown } from '../primitives';
import React from 'react';

const meta: Meta = { title: 'Showcase/Overview' };
export default meta;

export const Overview: StoryObj = {
  render: () => {
    const values = [1,2,1.5,1.8,2.2,2.0,2.4];
    return <div className="space-y-6 p-4">
      <div className="flex gap-2 flex-wrap"><Button>Primary</Button><Button variant='outline'>Outline</Button><Button variant='ghost'>Ghost</Button><Button variant='danger'>Danger</Button></div>
      <div className="grid grid-cols-3 gap-3"><MetricCard label='Portfolio Value' value={123456} delta={0.021} /><MetricCard label='P&L %' value={12.4} delta={-0.03} /><MetricCard label='Holdings' value={42} /></div>
      <Sparkline values={values} />
      <Tabs tabs={[{id:'a',label:'Tab A',content:<p>Content A</p>},{id:'b',label:'Tab B',content:<p>Content B</p>}]} />
      <SegmentedControl ariaLabel='Window' options={[{value:'30d',label:'30D'},{value:'90d',label:'90D'}]} value='30d' onChange={()=>{}} />
      <FactorBreakdown factors={[{name:'Rarity',weight:0.4},{name:'Demand',weight:0.35},{name:'Supply',weight:0.25}]} />
    </div>;
  }
};