FROM node:alpine
ADD ./package.json /opt/
WORKDIR /opt/
RUN yarn
