/** What a click on a link to another site is counted with: Plausible's `trackEvent`. */
export type TrackEvent = (eventName: string, options: { props: Record<string, string> }) => void;

/**
 * Counts clicks on links to other sites as Plausible's "Outbound Link: Click" event, and leaves the link alone.
 *
 * plausible-tracker's own `enableAutoOutboundTracking` cancels every outbound click and sets `location.href` itself a
 * moment later, so links meant for a new tab (`target="_blank"`: plugin pages, downloads) replaced the studio
 * instead. Here the click goes on as the browser decides: a new tab where the link asks for one, a middle click or
 * Ctrl-click as usual. A link that does leave the page may lose its count when the page unloads; that is the price of
 * never delaying or redirecting a click.
 */
export const trackOutboundLinks = (track: TrackEvent, root: Document = document): (() => void) => {
    const onClick = (event: MouseEvent) => {
        // Left and middle button; right-click only opens the context menu.
        if (event.button > 1) {
            return;
        }
        const link = (event.target as Element | null)?.closest?.('a[href]');
        if (!(link instanceof HTMLAnchorElement) || !/^https?:$/.test(link.protocol) || link.host === root.location?.host) {
            return;
        }
        track('Outbound Link: Click', { props: { url: link.href } });
    };
    root.addEventListener('click', onClick, true);
    root.addEventListener('auxclick', onClick, true);
    return () => {
        root.removeEventListener('click', onClick, true);
        root.removeEventListener('auxclick', onClick, true);
    };
};
