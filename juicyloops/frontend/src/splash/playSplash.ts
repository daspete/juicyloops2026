/**
 * Plays the studio splash when the studio is entered client side (a RouterLink from a marketing page), where the
 * inline copy in the /app shell never loads. It is the same file (`studio-splash.html`), appended to <body> in
 * document order: the style, the pre-script (which checks and sets the once-per-tab flag), the markup and the
 * controller. Scripts parsed from a string do not run, so each one is recreated; `data-spa` tells the pre-script
 * that this is a studio entry although the URL still shows the marketing page.
 */
import splash from './studio-splash.html?raw';

/** The sessionStorage key the splash sets once it has played in this tab (harnesses set it to skip the splash). */
export const SPLASH_FLAG = 'juicyloops:splash';

const alreadyPlayed = (): boolean => {
    try {
        return sessionStorage.getItem(SPLASH_FLAG) !== null;
    } catch {
        return false;
    }
};

export const playSplash = (): void => {
    if (alreadyPlayed() || document.getElementById('jl-splash')) {
        return;
    }
    const template = document.createElement('template');
    template.innerHTML = splash;
    for (const node of Array.from(template.content.childNodes)) {
        if (node instanceof HTMLScriptElement) {
            const script = document.createElement('script');
            script.setAttribute('data-spa', '');
            script.textContent = node.textContent;
            document.body.append(script);
            script.remove();
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            document.body.append(node);
        }
    }
};
