window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_client_schema_form = require("@deepseek-ai/dsh-client-schema-form");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		//#region lib/types/client/settings-scope.js
		/**
		* Host transport for the settings-namespace scope contract. The contract types
		* live in `dsh-client-runtime` (the common dependency of every feature that
		* owns a preference); this file owns the wire behavior and the invalidation
		* subscription, both of which are Settings-surface concerns.
		*/
		/** Read Storage defensively: sandboxed documents may throw on property access. */
		function browserStorage() {
			try {
				const candidate = Reflect.get(globalThis, "localStorage");
				if (typeof candidate !== "object" || candidate === null) return void 0;
				const storage = candidate;
				return typeof storage.getItem === "function" && typeof storage.setItem === "function" ? storage : void 0;
			} catch (_storageUnavailable) {
				return;
			}
		}
		/**
		* Serializes one namespace's Host reads and writes behind a snapshot store.
		* Reads never block plugin activation; writes carry the latest known
		* namespace revision and teardown waits for the operation already crossing
		* the wire.
		*/
		var SettingsScopeController = class {
			api;
			spec;
			persistence;
			store;
			tail = Promise.resolve();
			readGeneration = 0;
			writeGeneration = 0;
			disposed = false;
			browserValue = {};
			browserRevision = 0;
			/**
			* @param api - settings wire face.
			* @param spec - namespace identity and optional narrowing decoder.
			* @param persistence - Host, browser-origin, or process-local ownership.
			*/
			constructor(api, spec, persistence = "host") {
				this.api = api;
				this.spec = spec;
				this.persistence = persistence;
				this.store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
					status: persistence === "memory" ? "unavailable" : "loading",
					value: void 0,
					base: void 0,
					user: void 0,
					revision: void 0,
					writable: persistence === "browser",
					mode: persistence
				});
			}
			/** @returns the current sync snapshot (stable reference until the next change). */
			getSnapshot() {
				return this.store.getSnapshot();
			}
			/**
			* Observe snapshot replacements.
			* @param listener - invoked after each snapshot change.
			* @returns the disposer removing this listener.
			*/
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			/**
			* Queue a Host refresh; a newer read or user write suppresses stale publication.
			* @returns settlement after the queued read completes or is skipped.
			*/
			load() {
				const generation = ++this.readGeneration;
				if (this.persistence === "browser") {
					this.readBrowser(generation);
					return Promise.resolve();
				}
				return this.enqueue(() => this.read(generation));
			}
			/**
			* Queue one field write; see {@link SettingsScope.set} for the ordering,
			* revision, and recovery contract.
			* @param field - scalar field inside the namespace section.
			* @param value - JSON-shaped value selected by the user.
			* @returns settlement after the write and any latest-write recovery read.
			*/
			set(field, value) {
				return this.write({
					op: "set",
					path: [field],
					value
				});
			}
			/**
			* Queue one field clear; see {@link SettingsScope.unset} for the ordering,
			* revision, and recovery contract.
			* @param field - scalar field inside the namespace section.
			* @returns settlement after the clear and any latest-write recovery read.
			*/
			unset(field) {
				return this.write({
					op: "unset",
					path: [field]
				});
			}
			write(op) {
				this.readGeneration += 1;
				const generation = ++this.writeGeneration;
				if (this.persistence === "browser") {
					this.writeBrowser(op, generation);
					return Promise.resolve();
				}
				return this.enqueue(async () => {
					const revision = this.getSnapshot().revision;
					let response;
					try {
						response = await this.api.settings.mutate({
							ns: this.spec.namespace,
							ops: [op],
							...revision === void 0 ? {} : { expectedRevision: revision }
						});
					} catch (_settingsWriteFailure) {
						if (!this.disposed && generation === this.writeGeneration) await this.read(++this.readGeneration);
						return;
					}
					if (!response.result.ok) {
						if (!this.disposed && generation === this.writeGeneration) await this.read(++this.readGeneration);
						return;
					}
					this.accept(response.result.value, generation === this.writeGeneration);
				});
			}
			/**
			* Stop queued operations and wait for the current wire call to settle.
			* @returns settlement after the controller reaches quiescence.
			*/
			async dispose() {
				this.disposed = true;
				this.readGeneration += 1;
				this.writeGeneration += 1;
				await this.tail;
			}
			enqueue(operation) {
				if (this.persistence === "memory" || this.disposed) return Promise.resolve();
				const task = this.tail.then(async () => {
					if (this.disposed) return;
					await operation();
				});
				this.tail = task.catch(() => {});
				return task;
			}
			async read(generation) {
				let response;
				try {
					response = await this.api.settings.describe({});
				} catch (_settingsReadFailure) {
					return;
				}
				if (!response.result.ok || this.disposed) return;
				const { namespaces, writable } = response.result.value;
				const view = namespaces.find((candidate) => candidate.ns === this.spec.namespace);
				const publish = generation === this.readGeneration;
				if (view === void 0) {
					if (publish) this.store.update((draft) => {
						draft.status = "unavailable";
						draft.writable = writable;
					});
					return;
				}
				this.accept(view, publish, writable);
			}
			accept(view, publish, writable) {
				const decoded = publish ? this.decode(view) : void 0;
				this.store.update((draft) => {
					draft.revision = view.revision;
					draft.base = view.base;
					draft.user = view.user;
					if (writable !== void 0) draft.writable = writable;
					if (decoded === void 0) return;
					draft.status = "ready";
					draft.value = decoded;
				});
			}
			decode(view) {
				if (this.spec.decode !== void 0) return this.spec.decode(view.value);
				if (typeof view.value !== "object" || view.value === null || Array.isArray(view.value)) return void 0;
				let failure;
				try {
					failure = (0, _deepseek_ai_dsh_client_schema_form.validateDraft)((0, _deepseek_ai_dsh_client_schema_form.rehydrateSchema)(view.schema), view.value);
				} catch (_malformedSchemaEnvelope) {
					return;
				}
				return failure === void 0 ? view.value : void 0;
			}
			/** Storage key is origin-scoped by the browser; the namespace keeps features independent. */
			get browserStorageKey() {
				return this.persistence === "browser" ? `dsh.settings.${this.spec.namespace}` : void 0;
			}
			readBrowser(generation) {
				let value = this.browserValue;
				try {
					const key = this.browserStorageKey;
					const raw = key === void 0 ? null : browserStorage()?.getItem(key) ?? null;
					if (raw !== null) {
						const parsed = JSON.parse(raw);
						if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) value = { ...parsed };
					} else value = {};
				} catch (_storageUnavailableOrInvalid) {}
				if (this.disposed || generation !== this.readGeneration) return;
				this.browserValue = value;
				this.publishBrowser(value);
			}
			writeBrowser(op, generation) {
				if (this.disposed || generation !== this.writeGeneration) return;
				const [field] = op.path;
				if (field === void 0 || op.path.length !== 1) return;
				const value = op.op === "set" ? {
					...this.browserValue,
					[field]: op.value
				} : Object.fromEntries(Object.entries(this.browserValue).filter(([key]) => key !== field));
				this.browserValue = value;
				try {
					const key = this.browserStorageKey;
					if (key !== void 0) browserStorage()?.setItem(key, JSON.stringify(value));
				} catch (_storageUnavailable) {}
				this.publishBrowser(value);
			}
			publishBrowser(value) {
				const decoded = this.spec.decode === void 0 ? value : this.spec.decode(value);
				this.browserRevision += 1;
				this.store.update((draft) => {
					draft.status = decoded === void 0 ? "unavailable" : "ready";
					draft.value = decoded;
					draft.base = void 0;
					draft.user = value;
					draft.revision = this.browserRevision;
					draft.writable = true;
				});
			}
		};
		/**
		* The settings domain's base service. Features that own a preference reach the
		* settings transport through this service rather than a shared function: the
		* client bundle purity gate forbids cross-plugin value imports and directs
		* cross-plugin collaboration through cordis services
		* (`packages/client/tsdown.client.ts`).
		*/
		var SettingsScopeBinder = class extends _deepseek_ai_cordis.Service {
			controllers = /* @__PURE__ */ new Set();
			/**
			* @param ctx - the providing plugin's context.
			*/
			constructor(ctx) {
				super(ctx, "settingsScope");
			}
			/**
			* Bind one namespace scope to settings and connection invalidations on the
			* CALLER's plugin lifecycle — the service proxy binds `this.ctx` to the
			* caller at call time, so the scope's disposer belongs to the calling fiber.
			* Listeners exist before the initial background read starts, so activation
			* never blocks on the settings transport. The caller injects `connection`
			* for the transport and `remote` for the forwarded settings invalidation.
			* @param spec - domain-owned namespace contract.
			* @returns the bound scope consumed by the domain's services and rows.
			*/
			bind(spec) {
				const ctx = this.ctx;
				const connection = ctx.get("connection");
				const persistence = spec.browserLocal === true && !connection.isLoopback ? "browser" : connection.settingsAccess ?? (connection.isLoopback ? "host" : "memory");
				const controller = new SettingsScopeController(connection.api, spec, persistence);
				this.controllers.add(controller);
				ctx.effect(() => {
					const refresh = (namespace) => {
						if (namespace !== void 0 && namespace !== spec.namespace) return;
						controller.load();
					};
					const disposers = [ctx.get("remote").$on("settings/document-updated", refresh), ctx.on("connection/reset", () => {
						refresh();
					})];
					const storageKey = controller.browserStorageKey;
					if (storageKey !== void 0 && typeof globalThis.addEventListener === "function") {
						const onStorage = (event) => {
							if (event.key === storageKey) refresh();
						};
						globalThis.addEventListener("storage", onStorage);
						disposers.push(() => {
							globalThis.removeEventListener("storage", onStorage);
						});
					}
					controller.load();
					return async () => {
						for (const dispose of disposers) dispose();
						this.controllers.delete(controller);
						await controller.dispose();
					};
				}, `ui-settings: ${spec.namespace} settings scope`);
				return controller;
			}
			/**
			* Invalidate every Host-backed namespace after an embedding changes the
			* Runtime that owns otherwise ownerless settings requests. Each controller
			* increments its generation immediately, so an older target's in-flight
			* response cannot publish after this call.
			*/
			refreshAll() {
				for (const controller of this.controllers) controller.load();
			}
		};
		//#endregion
		//#region lib/types/client/index.js
		/**
		* Required services: none. The transport is resolved per caller through
		* `this.ctx` at `bind` time, so this plugin waits for nothing.
		*/
		const inject = [];
		/**
		* Provide the settings-namespace scope service.
		*
		* Constructing the service in this plugin's fiber keeps its traced methods
		* bound to each consuming plugin's context.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			new SettingsScopeBinder(ctx);
		}
		//#endregion
		exports.SettingsScopeBinder = SettingsScopeBinder;
		exports.SettingsScopeController = SettingsScopeController;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map