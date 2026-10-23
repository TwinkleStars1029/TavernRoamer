export function prepareFloatingHost(host: HTMLElement, targetWindow: Window): void {
  const viewport = targetWindow.visualViewport;
  const fullScreenStyles = floatingHostLayout(
    viewport?.width ?? targetWindow.innerWidth,
    viewport?.height ?? targetWindow.innerHeight
  );
  for (const [property, value] of Object.entries(fullScreenStyles)) {
    const cssProperty = property.startsWith('webkit')
      ? `-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
      : property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    host.style.setProperty(cssProperty, value, 'important');
  }
}

export function floatingHostLayout(viewportWidth: number, viewportHeight: number): Record<string, string> {
  return {
    position: 'fixed',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
    width: `${viewportWidth}px`,
    height: `${viewportHeight}px`,
    minWidth: '0',
    minHeight: '0',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    border: '0',
    transform: 'none',
    filter: 'none',
    perspective: 'none',
    contain: 'none',
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    touchAction: 'pan-y',
    webkitOverflowScrolling: 'touch',
    boxSizing: 'border-box',
    zIndex: '40000'
  };
}

export function isHtmlElement(value: Element | null, hostDocument: Document): value is HTMLElement {
  const HtmlElement = hostDocument.defaultView?.HTMLElement;
  return Boolean(value && HtmlElement && value instanceof HtmlElement);
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  return [...container.querySelectorAll<HTMLElement>(selector)].filter(element => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    return element.getAttribute('tabindex') !== '-1';
  });
}

export function getHostDocument(): Document {
  try {
    const parentDocument = globalThis.parent?.document;
    if (parentDocument?.querySelector('#extensions_settings2, #extensions_settings')) {
      return parentDocument;
    }
  } catch {
    return document;
  }
  return document;
}

export function findMountedPanel(): HTMLElement | null {
  try {
    const parentPanel = globalThis.parent?.document?.querySelector<HTMLElement>('#tavern-roamer-panel');
    if (parentPanel) {
      return parentPanel;
    }
  } catch {
    // 跨域或無 parent → 退回自身 document
  }
  return document.querySelector<HTMLElement>('#tavern-roamer-panel');
}

export function findMountPoint(hostDocument: Document): HTMLElement {
  return (
    hostDocument.querySelector<HTMLElement>('#extensions_settings2') ??
    hostDocument.querySelector<HTMLElement>('#extensions_settings') ??
    hostDocument.body
  );
}
