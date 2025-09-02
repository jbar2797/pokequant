/* Tailwind config referencing CSS variable tokens */
const plugin = require('tailwindcss/plugin');

module.exports = {
  darkMode: 'class',
  content: [
    './apps/**/*.{js,ts,jsx,tsx,mdx}',
    './packages/**/*.{js,ts,jsx,tsx,mdx}',
    './public/index.html'
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)']
      },
      colors: {
        brand: 'hsl(var(--brand))',
        accent: 'hsl(var(--accent))',
        success: 'hsl(var(--success))',
        neutral: 'hsl(var(--neutral))',
        danger: 'hsl(var(--danger))',
        bg: 'hsl(var(--bg))',
        fg: 'hsl(var(--fg))',
        muted: 'hsl(var(--muted))',
        card: 'hsl(var(--card))',
        border: 'hsl(var(--border))'
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)'
      },
      boxShadow: {
        elev1: 'var(--elev-1)',
        elev2: 'var(--elev-2)'
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        med: 'var(--dur-med)',
        slow: 'var(--dur-slow)'
      }
    }
  },
  plugins: [
    plugin(function({ addBase }) {
      addBase({
        ':root': {
          fontSize: '16px',
          lineHeight: 'var(--line-height)'
        },
        '*, *::before, *::after': {
          boxSizing: 'border-box'
        }
      });
    })
  ]
};
