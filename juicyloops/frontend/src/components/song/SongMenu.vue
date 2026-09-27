<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * A small context menu for the song editor, opened at the pointer. It closes on a pick, a press outside,
 * Escape, scrolling or a resize. Items without an action are separators.
 */
export interface SongMenuItem {
    label?: string;
    icon?: string;
    shortcut?: string;
    danger?: boolean;
    disabled?: boolean;
    checked?: boolean;
    action?: () => void;
}

const props = defineProps<{
    items: readonly SongMenuItem[];
    x: number;
    y: number;
    title?: string;
}>();

const emit = defineEmits<{
    close: [];
}>();

const menu = ref<HTMLElement | null>(null);
const position = ref({ left: props.x, top: props.y });

const pick = (item: SongMenuItem) => {
    if (item.disabled || !item.action) {
        return;
    }
    emit('close');
    item.action();
};

const onOutside = (event: PointerEvent) => {
    if (!menu.value?.contains(event.target as Node)) {
        emit('close');
    }
};

const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        emit('close');
    }
};

const close = () => emit('close');

onMounted(async () => {
    await nextTick();
    // Keep the whole menu on screen: flip it to the other side of the pointer where it would overflow.
    const rect = menu.value?.getBoundingClientRect();
    if (rect) {
        const left = props.x + rect.width > window.innerWidth - 8 ? Math.max(8, props.x - rect.width) : props.x;
        const top = props.y + rect.height > window.innerHeight - 8 ? Math.max(8, props.y - rect.height) : props.y;
        position.value = { left, top };
    }
    menu.value?.querySelector<HTMLElement>('.songmenu-item:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
});

onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('wheel', close);
});
</script>

<template>
    <Teleport to="body">
        <div ref="menu" class="songmenu" role="menu" :style="{ left: `${position.left}px`, top: `${position.top}px` }" @contextmenu.prevent>
            <div v-if="props.title" class="songmenu-title">{{ props.title }}</div>
            <template v-for="(item, index) in props.items" :key="index">
                <div v-if="!item.label" class="songmenu-sep" role="separator"></div>
                <button
                    v-else
                    type="button"
                    class="songmenu-item"
                    role="menuitem"
                    :disabled="item.disabled"
                    :data-danger="item.danger"
                    @click="pick(item)"
                    @keydown.down.prevent="(($event.target as HTMLElement).nextElementSibling as HTMLElement | null)?.focus()"
                    @keydown.up.prevent="(($event.target as HTMLElement).previousElementSibling as HTMLElement | null)?.focus()"
                >
                    <Icon v-if="item.checked !== undefined" :icon="item.checked ? 'mdi:checkbox-marked' : 'mdi:checkbox-blank-outline'" class="songmenu-icon" />
                    <Icon v-else-if="item.icon" :icon="item.icon" class="songmenu-icon" />
                    <span v-else class="songmenu-icon"></span>
                    <span class="songmenu-label">{{ item.label }}</span>
                    <kbd v-if="item.shortcut" class="songmenu-key">{{ item.shortcut }}</kbd>
                </button>
            </template>
        </div>
    </Teleport>
</template>
