import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        solob: {
          navy: '#0F172A',
          emerald: '#059669',
          amber: '#D97706',
          terracotta: '#C2410C',
          sand: '#FAF8F5',
        },
      },
    },
  },
  plugins: [],
};

export default config;
