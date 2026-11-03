/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'fx-primary': '#EF1B24',
        'fx-primary-hover': '#D9141D',
        'fx-primary-active': '#C7111A',
        'fx-primary-tint': '#FFF0F1',
        'fx-ink': '#111B37',
        'fx-body': '#334568',
        'fx-muted': '#657794',
        'fx-placeholder': '#94A3B8',
        'fx-surface': '#FFFFFF',
        'fx-app-bg': '#F6F8FC',
        'fx-bg-soft': '#F9FAFD',
        'fx-border': '#E3EAF3',
        'fx-border-strong': '#D4DFEC',
        'fx-success': '#0DBA67',
        'fx-success-soft': '#E9FBF1',
        'fx-warning': '#FFAA23',
        'fx-warning-soft': '#FFF6E5',
        'fx-error': '#F2343B',
        'fx-error-soft': '#FFF0F1',
        'fx-info': '#2A82E7',
        'fx-info-soft': '#EEF5FF',
        'fx-violet': '#8858EA',
        'fx-teal': '#21B5AE',
      },
      borderRadius: {
        card: '12px',
        control: '8px',
        sm: '6px',
        md: '10px',
        lg: '16px',
      },
      boxShadow: {
        card: '0 3px 16px rgba(24,44,75,0.04)',
      },
      fontFamily: {
        ui: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
