Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    subscription: { type: Object, value: {} }, authorization: { type: Object, value: {} },
    member: { type: Boolean, value: false }, busy: { type: Boolean, value: false }, feedback: { type: String, value: '' },
  },
  methods: {
    onAuthorize() { if (!this.data.busy && !this.data.authorization.storageBlocked) this.triggerEvent('authorize'); },
    onRetry() { if (!this.data.authorization.syncing) this.triggerEvent('retry'); },
  },
});
