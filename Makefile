.PHONY: install up

install:
	npm install
	cd ../FE && npm install

up:
	@trap 'kill 0' EXIT INT TERM; \
	node --watch app.js & \
	(cd ../FE && npm run dev) & \
	wait
