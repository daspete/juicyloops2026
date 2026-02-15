<template>
    <Suspense>
        <RouterView v-slot="{ Component }">
            <component :is="Component" />
        </RouterView>
    </Suspense>
</template>
