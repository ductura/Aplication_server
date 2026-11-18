export const metadata = {
  title: "Ductura",
  description: "Aplikacijski poslužitelj Ducture",
};

export default function RootLayout({ children }) {
  return (
    <html lang="hr">
      <body>{children}</body>
    </html>
  );
}
