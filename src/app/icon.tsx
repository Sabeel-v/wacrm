import { ImageResponse } from "next/og";

// Replaces the default Next.js favicon with the brand mark — Hostinger
// violet rounded square + white chat-square glyph — matching the
// sidebar logo in `src/components/layout/sidebar.tsx`. Next.js renders
// this at build time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Base64 PNG derived directly from src/asset/logo.png (trimmed and sized for 32x32 favicon display)
const LOGO_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAC4jAAAuIwF4pT92AAAFCElEQVRYhe2Vy28bRRzHt5R6Zn5jXuKEhKoekOAAF05ICAH/AgIkhGivvfQEJxCyBChrx4kfiZ3ETRPXXue1tuM4LzsP7KRJH0rS5rFOE0Ib0RYVCQkQhwDteveHZuw8mjhCAsGFfKXVrL2z+/v8vr/fzCjKkY50pH9TiMfEAHpdC+jqFtfV+5BUf+VJdeQ/C65owSd5v+cHnvUiT7stPlCPvN9z/+9/2OV6TEH9uKJXL0U5dug8kX2v51WedJs85UaeVE0+2IA85Z76Z1nt/w9rQLhcj4sB0uppGTSpWlxXTedoQNx3KrU/pB/fvfYFq2ZEJyInoRj6HAqhCBSazyi6y7Hzfg0AnlK9zlwQRXAJkAsg6HWf1QZ4VLu/sRKcX255mV6O3IMlDflCtMznowj5oL4DUYXcK55y55xDPuTJurJ0Qbih1324f55CS/rJE6va+46S9q5jJf4eLESe23UGj4mPs4XOSbasIZtufQBTYRMmm01+tQNhvCm5D6ICP+blPO2+yzP1lRIkVTEiTdW/fgCAlLqWyJ1+JBu9Jr2bQboSH9trJZuPnmMrGrLZtjKbaUOYbkUohGyYaDb5lXaE8aCuLEROVKBlcyo80/gKT3seVhvQ4mmPGLdY2v38QYC17p/IaheS1YRJSgmkq11bpBR/QTxzzF14kS7GfmTznchmIzabjQgXEIphhMlm4YDJZyMI+UCfhChW65/1fMCHG7ezt3jGK+43laKLHgQwtA3yTS+SUsIihmaRjT6kN7tOy2dLsQxb60F2rb3MrrYLCIvNtJkSoBBGmGgSvWDyS20Io/4+RW9k4j3I1AedY01i2Zk8qZadQ40ISbVwILgQMRLXyC0diSEBbLLeg9TQbtPFWI4uazZd6LTZXAeyK+fFaLPFOLJLrRYUwjZ8HRIlQMj7y1xADfumYKAhAlnvltx4Um5b7AVyCabUi0otOUpanmymkJS0sigBWdGQrnUju6UjvRG16fUo0rkOiy3Fkc53zLGpFi9cu/AHXGoVZRC9gDAWQBj1WXyyGZ2FMMqO7/dgtfamMx9ESLldNQGIkegm36WRGFWACoRFl+MmXYwhvV6FuB79jc2cf028w6bDZ+Fqu+gFC8abbBhvQsj5kY/4ynyw0eRZry0dEAApt8VlCdxnajtgaK3kbkY4IJtQXoaGdDmOdEkAdJbpei/SGxcrGYwGiYQohs9xAVEIlWEsaIPIcsSHsvmyDVjd+20JkZar4a3aDpS0L+n3AyLoHoAEUlGKxZhF13qQLMfnlMEIPLJzij2kGP5EQkw2lSEfsCEXQD7sQz4kALwVALEXpNy/k4x66pAeSHxccaCyDPeUwZYulBIP6Y3Ym3Jy5RBS9t7TQujT6n5Qhpzf5qN+FJbzQS/yjMeWbqTUezsJ7Bdd1z8it5OP9oAEiJt0M4XM0BoOBN8HwSabvwABkQ+aMOKzpQsicKbeco74EDL1MzWDC5HF6CnHRt/PYvkRIy5cKBNDe0g2k0jWewyl6H/60BNRbL3bEBNBD1w+j5ALmDDsE8evyQe8D5zFFuRZ71eHJiFEVmJnybd9SO702+RW0iKiJ252/0KXtTfkBMQDh82OxJG8XY6czw8zbcinW21nscUSwSHjmX2qS33m8CRclZOMGIm3SUnrcRjaFYehhRwr0Zf2Pv8LyUNLBGA5/zsw4uuBoYY0zzace3bA88ThwY90pP+z/gRvXkJRIww7agAAAABJRU5ErkJggg==";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img
          src={LOGO_DATA_URI}
          width="32"
          height="32"
        />
      </div>
    ),
    { ...size },
  );
}
