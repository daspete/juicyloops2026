import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackOutboundLinks } from '../../analytics/outboundLinks';

const link = (href: string, target?: string) => {
    const a = document.createElement('a');
    a.href = href;
    if (target) {
        a.target = target;
    }
    a.innerHTML = '<span>label</span>';
    document.body.append(a);
    return a;
};

describe('outbound link tracking', () => {
    let stop: (() => void) | null = null;
    afterEach(() => {
        stop?.();
        document.body.innerHTML = '';
    });

    it('counts a click on a link to another site and leaves the click alone', () => {
        const track = vi.fn();
        stop = trackOutboundLinks(track);
        const a = link('https://surge-synthesizer.github.io/', '_blank');
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        // Keep jsdom from trying to navigate; the check is whether the tracker cancelled it.
        a.addEventListener('click', (event) => {
            expect(event.defaultPrevented).toBe(false);
            event.preventDefault();
        });
        a.querySelector('span')!.dispatchEvent(click);
        expect(track).toHaveBeenCalledWith('Outbound Link: Click', { props: { url: 'https://surge-synthesizer.github.io/' } });
    });

    it('ignores links on this site, non-web links and right clicks', () => {
        const track = vi.fn();
        stop = trackOutboundLinks(track);
        const quiet = (event: Event) => event.preventDefault();
        for (const a of [link(`${location.origin}/imprint`), link('mailto:someone@example.org')]) {
            a.addEventListener('click', quiet);
            a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        const outside = link('https://example.org/');
        outside.addEventListener('auxclick', quiet);
        outside.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
        expect(track).not.toHaveBeenCalled();
    });

    it('counts middle clicks and stops when asked', () => {
        const track = vi.fn();
        stop = trackOutboundLinks(track);
        const a = link('https://example.org/');
        a.addEventListener('auxclick', (event) => event.preventDefault());
        a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
        expect(track).toHaveBeenCalledTimes(1);
        stop();
        stop = null;
        a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
        expect(track).toHaveBeenCalledTimes(1);
    });
});
