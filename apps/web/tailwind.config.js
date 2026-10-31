/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0d1220",
        panel: "#111a2b",
        line: "#263249",
        accent: "#76e0bd"
      }
    }
  },
  plugins: []
};
