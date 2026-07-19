import type { Config } from "tailwindcss";

export default {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			fontFamily: {
				sans: [
					'Fredoka',
					'ui-rounded',
					'ui-sans-serif',
					'system-ui',
					'-apple-system',
					'sans-serif'
				],
				display: [
					'"Bagel Fat One"',
					'Fredoka',
					'ui-rounded',
					'ui-sans-serif',
					'system-ui',
					'sans-serif'
				],
				mono: [
					'"JetBrains Mono"',
					'ui-monospace',
					'SFMono-Regular',
					'Menlo',
					'monospace'
				]
			},
			colors: {
				nori: {
					'h0f0e0c': 'hsl(var(--nori-h0f0e0c) / <alpha-value>)',
					'h14131a': 'hsl(var(--nori-h14131a) / <alpha-value>)',
					'h171512': 'hsl(var(--nori-h171512) / <alpha-value>)',
					'h1e293b': 'hsl(var(--nori-h1e293b) / <alpha-value>)',
					'h1f2937': 'hsl(var(--nori-h1f2937) / <alpha-value>)',
					'h242019': 'hsl(var(--nori-h242019) / <alpha-value>)',
					'h2a2833': 'hsl(var(--nori-h2a2833) / <alpha-value>)',
					'h2a6b33': 'hsl(var(--nori-h2a6b33) / <alpha-value>)',
					'h2c2b3a': 'hsl(var(--nori-h2c2b3a) / <alpha-value>)',
					'h2c5282': 'hsl(var(--nori-h2c5282) / <alpha-value>)',
					'h2f7d5b': 'hsl(var(--nori-h2f7d5b) / <alpha-value>)',
					'h34d399': 'hsl(var(--nori-h34d399) / <alpha-value>)',
					'h374151': 'hsl(var(--nori-h374151) / <alpha-value>)',
					'h3d6ea5': 'hsl(var(--nori-h3d6ea5) / <alpha-value>)',
					'h3f9a4c': 'hsl(var(--nori-h3f9a4c) / <alpha-value>)',
					'h43a04e': 'hsl(var(--nori-h43a04e) / <alpha-value>)',
					'h475569': 'hsl(var(--nori-h475569) / <alpha-value>)',
					'h4d463a': 'hsl(var(--nori-h4d463a) / <alpha-value>)',
					'h4d6a1e': 'hsl(var(--nori-h4d6a1e) / <alpha-value>)',
					'h4e9d55': 'hsl(var(--nori-h4e9d55) / <alpha-value>)',
					'h5a5346': 'hsl(var(--nori-h5a5346) / <alpha-value>)',
					'h5c5344': 'hsl(var(--nori-h5c5344) / <alpha-value>)',
					'h5c564b': 'hsl(var(--nori-h5c564b) / <alpha-value>)',
					'h6b6878': 'hsl(var(--nori-h6b6878) / <alpha-value>)',
					'h6f6858': 'hsl(var(--nori-h6f6858) / <alpha-value>)',
					'h799c2a': 'hsl(var(--nori-h799c2a) / <alpha-value>)',
					'h7a4a13': 'hsl(var(--nori-h7a4a13) / <alpha-value>)',
					'h7a7060': 'hsl(var(--nori-h7a7060) / <alpha-value>)',
					'h857b6b': 'hsl(var(--nori-h857b6b) / <alpha-value>)',
					'h8a2f20': 'hsl(var(--nori-h8a2f20) / <alpha-value>)',
					'h8a5620': 'hsl(var(--nori-h8a5620) / <alpha-value>)',
					'h8a5a12': 'hsl(var(--nori-h8a5a12) / <alpha-value>)',
					'h8ab135': 'hsl(var(--nori-h8ab135) / <alpha-value>)',
					'h8f2318': 'hsl(var(--nori-h8f2318) / <alpha-value>)',
					'h94a3b8': 'hsl(var(--nori-h94a3b8) / <alpha-value>)',
					'h9ca3af': 'hsl(var(--nori-h9ca3af) / <alpha-value>)',
					'ha06a1e': 'hsl(var(--nori-ha06a1e) / <alpha-value>)',
					'ha3271c': 'hsl(var(--nori-ha3271c) / <alpha-value>)',
					'ha39887': 'hsl(var(--nori-ha39887) / <alpha-value>)',
					'hb03a29': 'hsl(var(--nori-hb03a29) / <alpha-value>)',
					'hb05ffe': 'hsl(var(--nori-hb05ffe) / <alpha-value>)',
					'hb06a1c': 'hsl(var(--nori-hb06a1c) / <alpha-value>)',
					'hb4442e': 'hsl(var(--nori-hb4442e) / <alpha-value>)',
					'hb9bfc9': 'hsl(var(--nori-hb9bfc9) / <alpha-value>)',
					'hbfcf9f': 'hsl(var(--nori-hbfcf9f) / <alpha-value>)',
					'hc0392b': 'hsl(var(--nori-hc0392b) / <alpha-value>)',
					'hc97929': 'hsl(var(--nori-hc97929) / <alpha-value>)',
					'hcbd5e1': 'hsl(var(--nori-hcbd5e1) / <alpha-value>)',
					'hcde8b5': 'hsl(var(--nori-hcde8b5) / <alpha-value>)',
					'hd24a3d': 'hsl(var(--nori-hd24a3d) / <alpha-value>)',
					'hd98b3d': 'hsl(var(--nori-hd98b3d) / <alpha-value>)',
					'hd9d1c5': 'hsl(var(--nori-hd9d1c5) / <alpha-value>)',
					'hdb9346': 'hsl(var(--nori-hdb9346) / <alpha-value>)',
					'hdf6dd4': 'hsl(var(--nori-hdf6dd4) / <alpha-value>)',
					'he4f3e2': 'hsl(var(--nori-he4f3e2) / <alpha-value>)',
					'he5e1d2': 'hsl(var(--nori-he5e1d2) / <alpha-value>)',
					'hebe8db': 'hsl(var(--nori-hebe8db) / <alpha-value>)',
					'hefe8d6': 'hsl(var(--nori-hefe8d6) / <alpha-value>)',
					'heff4ff': 'hsl(var(--nori-heff4ff) / <alpha-value>)',
					'hf3f1e8': 'hsl(var(--nori-hf3f1e8) / <alpha-value>)',
					'hf5f0e6': 'hsl(var(--nori-hf5f0e6) / <alpha-value>)',
					'hf6f4eb': 'hsl(var(--nori-hf6f4eb) / <alpha-value>)',
					'hf8f4ea': 'hsl(var(--nori-hf8f4ea) / <alpha-value>)',
					'hfb923c': 'hsl(var(--nori-hfb923c) / <alpha-value>)',
					'hfbecea': 'hsl(var(--nori-hfbecea) / <alpha-value>)',
					'hfbfaf5': 'hsl(var(--nori-hfbfaf5) / <alpha-value>)',
					'hfde7e4': 'hsl(var(--nori-hfde7e4) / <alpha-value>)',
					'hfdf1de': 'hsl(var(--nori-hfdf1de) / <alpha-value>)',
					'hfdf3e6': 'hsl(var(--nori-hfdf3e6) / <alpha-value>)',
					'hff6b35': 'hsl(var(--nori-hff6b35) / <alpha-value>)',
					'hffd4d4': 'hsl(var(--nori-hffd4d4) / <alpha-value>)',
					'hffdd44': 'hsl(var(--nori-hffdd44) / <alpha-value>)',
					'hffe9a8': 'hsl(var(--nori-hffe9a8) / <alpha-value>)',
					'hfffdf7': 'hsl(var(--nori-hfffdf7) / <alpha-value>)'
				},
				// NORI website palette
				paper: {
					DEFAULT: 'hsl(var(--nori-hfbfaf5) / <alpha-value>)',
					2: 'hsl(var(--nori-hf3f1e8) / <alpha-value>)',
					3: 'hsl(var(--nori-hebe8db) / <alpha-value>)'
				},
				ink: {
					DEFAULT: 'hsl(var(--nori-h14131a) / <alpha-value>)',
					2: 'hsl(var(--nori-h2a2833) / <alpha-value>)'
				},
				mute: 'hsl(var(--nori-h6b6878) / <alpha-value>)',
				sticker: {
					DEFAULT: 'hsl(var(--nori-hffe9a8) / <alpha-value>)',
					2: 'hsl(var(--nori-hffd4d4) / <alpha-value>)'
				},
				leaf: 'hsl(var(--nori-hcde8b5) / <alpha-value>)',
				tan: 'hsl(var(--nori-hefe8d6) / <alpha-value>)',
				steel: 'hsl(var(--nori-hb9bfc9) / <alpha-value>)',
				moss: 'hsl(var(--nori-hbfcf9f) / <alpha-value>)',
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				sidebar: {
					DEFAULT: 'hsl(var(--sidebar-background))',
					foreground: 'hsl(var(--sidebar-foreground))',
					primary: 'hsl(var(--sidebar-primary))',
					'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
					accent: 'hsl(var(--sidebar-accent))',
					'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
					border: 'hsl(var(--sidebar-border))',
					ring: 'hsl(var(--sidebar-ring))'
				}
			},
			transitionTimingFunction: {
				nori: 'cubic-bezier(0.22, 1, 0.36, 1)',
				bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
			},
			boxShadow: {
				soft: '0 1px 0 rgba(20, 19, 26, 0.04), 0 8px 24px -12px rgba(20, 19, 26, 0.12)',
				pop: '0 2px 0 rgba(20, 19, 26, 0.06), 0 20px 40px -20px rgba(20, 19, 26, 0.25)'
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			keyframes: {
				'fade-in-up': {
					from: {
						opacity: '0',
						transform: 'translateY(10px)'
					},
					to: {
						opacity: '1',
						transform: 'translateY(0)'
					}
				},
				floaty: {
					'0%, 100%': {
						transform: 'translateY(0)'
					},
					'50%': {
						transform: 'translateY(-4px)'
					}
				},
				'accordion-down': {
					from: {
						height: '0'
					},
					to: {
						height: 'var(--radix-accordion-content-height)'
					}
				},
				'accordion-up': {
					from: {
						height: 'var(--radix-accordion-content-height)'
					},
					to: {
						height: '0'
					}
				}
			},
			animation: {
				'fade-in-up': 'fade-in-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
				floaty: 'floaty 3.4s ease-in-out infinite',
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out'
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
} satisfies Config;
