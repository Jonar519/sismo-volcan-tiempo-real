import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "consola volcan",
  description: "quiz caso 1",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
