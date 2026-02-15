import '@/assets/css/main.css';
import { createApp } from 'vue';
import { router } from '@/router';
import { theme } from '@/theme';
import App from './app.vue';

const app = createApp(App);

router(app);
theme(app);

app.mount('#app');
