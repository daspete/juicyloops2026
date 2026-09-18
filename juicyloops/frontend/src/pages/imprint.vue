<script setup lang="ts">
/**
 * Legal notice (Impressum) as required in Austria by § 5 ECG and § 25 MedienG, plus the short
 * privacy notes a visitor needs. Fill in `OWNER` before the page goes live.
 */
const OWNER = {
    name: '[Full name]',
    street: '[Street and number]',
    city: '[Postal code] Vienna',
    country: 'Austria',
    email: '[email address]',
    website: 'https://daspete.at',
};
</script>

<template>
    <main class="mk-page mk-imprint">
        <header class="mk-imprint-head">
            <p class="mk-eyebrow">Imprint</p>
            <h1 class="mk-h1 mk-h1--small">Who runs this, and what the site does with your data.</h1>
        </header>

        <section class="mk-imprint-section" aria-labelledby="owner-title">
            <h2 id="owner-title" class="mk-h3">Information according to § 5 ECG and § 25 MedienG</h2>
            <address class="mk-imprint-address">
                <strong>{{ OWNER.name }}</strong><br />
                {{ OWNER.street }}<br />
                {{ OWNER.city }}<br />
                {{ OWNER.country }}<br />
                <a :href="`mailto:${OWNER.email}`">{{ OWNER.email }}</a><br />
                <a :href="OWNER.website" target="_blank" rel="noopener noreferrer">{{ OWNER.website }}</a>
            </address>
            <p>
                Juicy Loops is a free, private project: a web app for making music in the browser. It is not a company and sells nothing. The
                editorial line of this site is to describe and provide that app.
            </p>
        </section>

        <section class="mk-imprint-section" aria-labelledby="privacy-title">
            <h2 id="privacy-title" class="mk-h3">Privacy</h2>
            <ul class="mk-imprint-list">
                <li>
                    <strong>No accounts.</strong> There is no signup and no login. Sessions you save are files on your own disk; they are never
                    uploaded.
                </li>
                <li>
                    <strong>Microphone.</strong> The Mic track asks your browser for microphone access and records only while you press record.
                    Recordings stay in your browser and inside your session file.
                </li>
                <li>
                    <strong>Analytics.</strong> Page views are counted with Plausible, a cookie-free analytics service, hosted by the owner. It
                    stores no personal data and no identifier that survives the day.
                </li>
                <li>
                    <strong>Fonts.</strong> The typefaces are loaded from Google Fonts, so your browser requests them from Google's servers and
                    transmits your IP address in doing so.
                </li>
                <li>
                    <strong>Discussions.</strong> The discussion panel in the studio is provided by Giscus and backed by GitHub Discussions. It
                    loads only when you open it, and posting requires a GitHub account under GitHub's terms.
                </li>
                <li>
                    <strong>Local storage.</strong> Your theme choice and studio preferences are kept in your browser's local storage. They never
                    leave it.
                </li>
            </ul>
        </section>

        <section class="mk-imprint-section" aria-labelledby="liability-title">
            <h2 id="liability-title" class="mk-h3">Liability and copyright</h2>
            <p>
                The app is provided as is, without warranty of any kind. The content of this site was created with care; still, no
                responsibility is taken for its accuracy or completeness. Linked sites are the responsibility of their owners; they were checked
                when the link was placed.
            </p>
            <p>
                Juicy Loops, its logo and its design are the work of the owner. Music you make with it is yours. Samples and recordings you bring
                into the app remain the property of whoever owns them.
            </p>
        </section>
    </main>
</template>
