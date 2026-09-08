"use client";

import { motion, useReducedMotion } from "motion/react";

const LINES = [
  "asciiplay 0.1.0",
  "ffmpeg 7.1.1 . rec.709 luma . truecolor",
  "no upload. the file never leaves this tab.",
];

export default function BootLines() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="boot" aria-label="asciiplay">
      {LINES.map((line, index) => (
        <motion.p
          key={line}
          className="boot-line"
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: reduceMotion ? 0 : index * 0.14, duration: 0.25 }}
        >
          <span className="prompt">&gt;</span> {line}
          {index === LINES.length - 1 ? <span className="cursor" /> : null}
        </motion.p>
      ))}
    </div>
  );
}
