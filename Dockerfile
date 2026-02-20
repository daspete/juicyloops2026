FROM node:24 AS build

ARG PORT=3000
ARG HOST=0.0.0.0

ENV NODE_ENV=production
ENV PORT=$PORT
ENV HOST=$HOST

WORKDIR /app

RUN ls -ahl

COPY ./juicyloops/frontend /app

RUN ls -ahl

RUN corepack enable
RUN yarn install

RUN ls -ahl

RUN yarn build

FROM nginx:latest AS runtime

COPY ./dev/nginx/production.juicyloops.daspete.test.conf /etc/nginx/nginx.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 3000

ENTRYPOINT [ "nginx", "-c", "/etc/nginx/nginx.conf" ]

CMD [ "-g", "daemon off;" ]