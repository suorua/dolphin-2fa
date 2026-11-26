tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Fredoka', 'Noto Sans SC', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
                mono: ['JetBrains Mono', 'monospace'],
            },
            colors: {
                ocean: {
                    50: '#f0f9ff',
                    100: '#e0f2fe',
                    200: '#bae6fd',
                    300: '#7dd3fc',
                    400: '#38bdf8',
                    500: '#0ea5e9',
                    600: '#0284c7',
                    900: '#0c2340',
                    950: '#061326',
                },
                mint: {
                    50: '#ecfdf5',
                    100: '#d1fae5',
                    400: '#34d399',
                    500: '#10b981',
                },
                coral: {
                    400: '#fb7185',
                    500: '#f43f5e',
                }
            },
            boxShadow: {
                'candy': '0 10px 25px -5px rgba(56, 189, 248, 0.18), 0 8px 10px -6px rgba(56, 189, 248, 0.1)',
                'candy-btn': '0 4px 0 0 #0284c7',
                'candy-btn-active': '0 1px 0 0 #0284c7',
                'candy-mint': '0 4px 0 0 #059669',
            }
        }
    }
};
