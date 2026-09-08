import AsciiPlayer from "@/components/AsciiPlayer";
import BootLines from "@/components/BootLines";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/BrandtChristian/asciiplay/main/install.sh | sh";

export default function Home() {
  return (
    <main className="page">
      <header className="masthead">
        <BootLines />
      </header>

      <AsciiPlayer />

      <section className="terminal-pitch">
        <h2>It is nicer in a real terminal</h2>
        <p>
          The browser version re-encodes every frame from a canvas, which is why the controls
          respond instantly. The terminal version does the same arithmetic in Rust against a raw
          ffmpeg pipe, keeps its clock from the audio device so sound never drifts, and plays
          YouTube URLs from your own machine.
        </p>
        <pre className="install">
          <code>{INSTALL_COMMAND}</code>
        </pre>
        <p className="dim">
          One static binary into <code>~/.local/bin</code>, checksum verified. It reports on ffmpeg
          and yt-dlp and prints the command each needs, and deliberately does not run your package
          manager for you.
        </p>
        <ul className="flags">
          <li>
            <code>--charset shades</code> Block Elements, much more saturated
          </li>
          <li>
            <code>--blocks</code> half blocks, double vertical resolution
          </li>
          <li>
            <code>--benchmark 240</code> what your terminal can actually take
          </li>
        </ul>
      </section>

      <footer className="footer">
        <a href="https://github.com/BrandtChristian/asciiplay">source</a>
        <span className="dim">
          demo clip: Big Buck Bunny, (c) Blender Foundation, CC BY 3.0. mandelbrot: generated with
          ffmpeg.
        </span>
      </footer>
    </main>
  );
}
