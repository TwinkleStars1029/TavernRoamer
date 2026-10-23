// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { injectStyle } from '../src/ui/styles';

afterEach(() => {
  document.querySelector('#tavern-roamer-style')?.remove();
});

describe('panel accessibility and responsive styles', () => {
  it('keeps keyboard focus visible on the custom controls', () => {
    injectStyle(document);
    const css = document.querySelector<HTMLStyleElement>('#tavern-roamer-style')?.textContent ?? '';

    expect(css).toMatch(/\.tr-task-card[\s\S]*:focus-visible/);
    expect(css).toContain('outline: 3px solid var(--tr-accent)');
  });

  it('wraps the footer on phones and stacks full-width actions at 360px', () => {
    injectStyle(document);
    const css = document.querySelector<HTMLStyleElement>('#tavern-roamer-style')?.textContent ?? '';
    const phone = css.slice(css.indexOf('@media (max-width: 480px)'), css.indexOf('@media (max-width: 360px)'));
    const narrow = css.slice(css.indexOf('@media (max-width: 360px)'), css.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(phone).toMatch(/\.tr-step-footer\s*\{[\s\S]*?flex-wrap:\s*wrap/);
    expect(narrow).toMatch(/\.tr-step-footer\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(narrow).toMatch(/\.tr-step-footer > \.menu_button,[\s\S]*?width:\s*100% !important/);
  });

  it('disables non-essential motion when reduced motion is requested', () => {
    injectStyle(document);
    const css = document.querySelector<HTMLStyleElement>('#tavern-roamer-style')?.textContent ?? '';
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reducedMotion).toContain('animation-duration: .01ms !important');
    expect(reducedMotion).toContain('scroll-behavior: auto !important');
    expect(reducedMotion).toContain('transition-duration: .01ms !important');
  });
});
