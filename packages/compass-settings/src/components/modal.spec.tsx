import React from 'react';
import type { ComponentProps } from 'react';
import {
  render,
  screen,
  within,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { spy, stub } from 'sinon';
import type { SinonSpy } from 'sinon';
import { expect } from 'chai';
import { Provider } from 'react-redux';
import userEvent from '@testing-library/user-event';

import configureStore from '../../test/configure-store';
import { SettingsModal } from './modal';

describe('SettingsModal', function () {
  let onCloseSpy: SinonSpy;
  let fetchSettingsSpy: SinonSpy;
  let onSaveSpy: SinonSpy;
  let onSelectTabSpy: SinonSpy;
  let renderSettingsModal: (
    props?: Partial<ComponentProps<typeof SettingsModal>>
  ) => void;

  beforeEach(function () {
    onCloseSpy = spy();
    fetchSettingsSpy = stub().resolves();
    onSaveSpy = spy();
    onSelectTabSpy = spy();

    const store = configureStore();
    renderSettingsModal = (
      props: Partial<ComponentProps<typeof SettingsModal>> = {}
    ) => {
      render(
        <Provider store={store}>
          <SettingsModal
            isOpen={false}
            onClose={onCloseSpy}
            fetchSettings={fetchSettingsSpy}
            onSave={onSaveSpy}
            onSelectTab={onSelectTabSpy}
            loadingState="ready"
            hasChangedSettings={false}
            {...props}
          />
        </Provider>
      );
    };
  });

  afterEach(function () {
    cleanup();
  });

  it('renders nothing until it is open and loaded', function () {
    renderSettingsModal({ isOpen: false });

    expect(fetchSettingsSpy.called).to.be.false;
    const container = screen.queryByTestId('settings-modal');
    expect(container).to.not.exist;
  });

  it('modal footer actions', async function () {
    renderSettingsModal({ isOpen: true, hasChangedSettings: true });
    expect(onSaveSpy.callCount).to.equal(0);

    await waitFor(() => {
      const container = screen.getByTestId('settings-modal');
      const saveButton = within(container).getByTestId('submit-button');
      expect(saveButton).to.exist;

      userEvent.click(saveButton);
      expect(onSaveSpy.calledOnce).to.be.true;
    });
  });

  it('navigates between settings', async function () {
    renderSettingsModal({ isOpen: true });

    let sidebar!: HTMLElement;
    await waitFor(() => {
      const container = screen.getByTestId('settings-modal');
      sidebar = within(container).getByTestId('settings-modal-sidebar');
      expect(sidebar).to.exist;
    });

    for (const option of ['privacy']) {
      const button = within(sidebar).getByTestId(`sidebar-${option}-item`);
      expect(button, `it renders ${option} button`).to.exist;
      userEvent.click(button);

      const selectedTab = onSelectTabSpy.lastCall.args[0];
      expect(selectedTab).to.equal(option);
      cleanup();
      renderSettingsModal({ isOpen: true, selectedTab });
      const tab = screen.getByTestId('settings-modal-content');
      expect(
        tab.getAttribute('aria-labelledby'),
        `it renders ${option} tab`
      ).to.equal(`${option}-tab`);
    }
  });
});
