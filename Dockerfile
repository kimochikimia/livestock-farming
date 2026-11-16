FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Өгөгдөл MySQL-д; зургууд энэ хавтсанд (байнгын диск холбоно)
ENV UPLOAD_DIR=/data/uploads
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
