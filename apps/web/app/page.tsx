import { AppShell } from '../../../packages/ui';
export default function HomePage() {
  return <AppShell header={<div className="text-sm font-semibold">Dashboard</div>} sidebar={<ul className="text-sm space-y-2"><li>Dashboard</li><li>Search</li><li>Portfolio</li></ul>}>
    <h1 className="text-lg font-semibold mb-4">Dashboard</h1>
    <p>Top Movers section coming soon.</p>
  </AppShell>;
}
