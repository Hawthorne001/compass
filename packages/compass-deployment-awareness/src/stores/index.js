import Reflux from 'reflux';
import StateMixin from 'reflux-state-mixin';

const ATLAS_REGEX = /mongodb.net[:/]/i;

/**
 * Constants for various environments MongoDB can run in.
 */
const ATLAS = 'atlas';
const ADL = 'adl';
const ON_PREM = 'on-prem';

/**
 * Deployment Awareness store.
 */
const DeploymentAwarenessStore = Reflux.createStore({
  /**
   * adds a state to the store, similar to React.Component's state
   * @see https://github.com/yonatanmn/Super-Simple-Flux#reflux-state-mixin
   *
   * If you call `this.setState({...})` this will cause the store to trigger
   * and push down its state as props to connected components.
   */
  mixins: [StateMixin.store],

  /**
   * Setup listeners to the app registry.
   *
   * @param {AppRegistry} appRegistry - The app registry.
   */
  onActivated(appRegistry) {
    this.appRegistry = appRegistry;
    appRegistry.on('data-service-initialized', this.onDataServiceInitialized.bind(this));
    appRegistry.on('instance-refreshed', (state) => {
      const isAtlas = !!state.instance._id.match(ATLAS);
      const isDataLake = state.instance.dataLake && state.instance.dataLake.isDataLake;
      if (isAtlas && !isDataLake) {
        this.setState({ isDataLake: false, env: ATLAS });
      } else if (isDataLake) {
        this.setState({ isDataLake: true, env: ADL });
      }
    });
  },

  /**
   * When the data service is initialized this is called in order to set up
   * listeners for SDAM events.
   *
   * @param {DataService} dataService - The data service.
   */
  onDataServiceInitialized(dataService) {
    dataService.on('topologyDescriptionChanged', this.topologyDescriptionChanged.bind(this));
  },

  /**
   * When the topology description changes, we should trigger the store with the data.
   *
   * @param {Event} evt - The topologyDescriptionChanged event.
   */
  topologyDescriptionChanged(evt) {
    const newDescription = evt.newDescription;
    const servers = [];
    for (const desc of newDescription.servers.values()) {
      servers.push({
        address: desc.address,
        type: desc.type,
        tags: desc.tags
      });
    }
    if (this.state.topologyType !== newDescription.type) {
      this.appRegistry.emit(
        'compass:deployment-awareness:topology-changed',
        {
          topologyType: newDescription.type,
          setName: newDescription.setName,
          servers: servers,
          env: this.state.env
        }
      );
    }
    this.setState({
      topologyType: newDescription.type,
      setName: newDescription.setName,
      servers: servers
    });
  },

  /**
   * Initialize the Deployment Awareness store state. The returned object must
   * contain all keys that you might want to modify with this.setState().
   *
   * @return {Object} initial store state.
   */
  getInitialState() {
    return {
      topologyType: 'Unknown',
      setName: '',
      servers: [],
      isDataLake: false,
      env: ON_PREM
    };
  }
});

export default DeploymentAwarenessStore;
