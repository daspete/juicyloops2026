import type { useConfirm } from 'primevue';

type ConfirmService = ReturnType<typeof useConfirm>;
type ConfirmOptions = Parameters<ConfirmService['require']>[0] & { target: HTMLElement };

/**
 * Opens PrimeVue's ConfirmPopup next to `target` when the confirmation does not come from a click on the target itself
 * (an item of a context menu). ConfirmPopup (4.5) only places itself from its document click listener: normally the
 * click that opened it reaches the document right after and aligns it. From a menu no such click comes, and the popup
 * sits in the top left corner. So once it has rendered, a click on the popup itself (which it takes as "inside",
 * not as a click outside that closes it) makes it align to its target.
 */
export const confirmAnchored = (confirm: ConfirmService, options: ConfirmOptions): void => {
    confirm.require(options);
    requestAnimationFrame(() => {
        document.querySelector('.p-confirmpopup')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};
