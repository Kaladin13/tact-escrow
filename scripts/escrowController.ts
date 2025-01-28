import { Address, Cell, fromNano, OpenedContract, toNano } from '@ton/core';
import { compile, NetworkProvider, UIProvider } from '@ton/blueprint';
import {
    promptAddress,
    promptAmount,
    promptBool,
    promptCell,
    promptNumber,
    waitForTransaction,
} from '../utils/ui-utils';
import { Maybe } from '@ton/core/dist/utils/maybe';
import { JettonMinter } from '../wrappers/ft/JettonMinter';
import { JettonWallet } from '../wrappers/ft/JettonWallet';
import { Escrow } from '../wrappers/Escrow';

let escrowContract: OpenedContract<Escrow>;

const contractActions = ['Create new escrow deal', 'Choose existing escrow deal'];
const generalActions = ['Get status', 'Get info', 'Get royalty', 'Change wallet code', 'Quit'];
const buyerActions = ['Fund'];
const guarantorActions = ['Approve deal', 'Cancel deal'];

const getStatusDeal = async (provider: NetworkProvider, ui: UIProvider) => {
    const status = await escrowContract.getEscrowInfo();

    ui.write(`Current deal status is ${!status.isFunded ? 'INITIALIZED' : 'FUNDED'}`);
};

const getWalletAddress = async (provider: NetworkProvider, ui: UIProvider) => {
    const jAddress = await escrowContract.getWalletAddress();

    ui.write(`Escrow contract jetton wallet address is ${jAddress.toString({ urlSafe: true })}`);
};

const getRoyalty = async (provider: NetworkProvider, ui: UIProvider) => {
    const roylaty = await escrowContract.getCalculateRoyaltyAmount();

    ui.write(`Escrow deal guarantor royalty is ${fromNano(roylaty).toString()}`);
};

const getInfo = async (provider: NetworkProvider, ui: UIProvider) => {
    const info = await escrowContract.getEscrowInfo();
    const assetInfoStr =
        info.assetAddress === null ? 'TON' : `Jetton with address ${info.assetAddress.toString({ urlSafe: true })}`;

    ui.write(`Escrow id is ${info.id}`);
    ui.write(`Seller address is ${info.sellerAddress.toString({ urlSafe: true })}`);
    ui.write(`Guarantor address is ${info.guarantorAddress.toString({ urlSafe: true })}`);
    ui.write(`Buyer address is ${info.buyerAddress?.toString({ urlSafe: true })}`);
    ui.write(`Deal amount is ${fromNano(info.dealAmount).toString()}`);
    ui.write(`Current deal status is ${!info.isFunded ? 'INITIALIZED' : 'FUNDED'}`);
    ui.write(`Guarantor royalty percent is ${Number(info.guarantorRoyaltyPercent) / 1000}%`);
    ui.write(`Deal asset is ${assetInfoStr}`);
};

const fundingAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const info = await escrowContract.getEscrowInfo();
    const assetInfoStr =
        info.assetAddress === null ? 'TON' : `Jetton with address ${info.assetAddress.toString({ urlSafe: true })}`;
    ui.write(`Deal asset is ${assetInfoStr}`);
    ui.write(`Deal amount is ${fromNano(info.dealAmount)}`);

    const isFundungSure = await promptBool('Are you sure you want to fund deal?', ['Yes', 'No'], ui);

    if (!isFundungSure) {
        return;
    }

    const api = provider.api();

    const lastTransaction = (await api.provider(escrowContract.address).getState()).last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    if (info.assetAddress === null) {
        await escrowContract.send(
            provider.sender(),
            {
                value: info.dealAmount,
            },
            'funding',
        );
    } else {
        try {
            const minter = provider.open(JettonMinter.createFromAddress(info.assetAddress));
            const buyerJettonWallet = provider.open(
                JettonWallet.createFromAddress(await minter.getWalletAddress(provider.sender().address!)),
            );

            ui.write(`Buyer jetton wallet is ${buyerJettonWallet.address.toString({ urlSafe: true })}`);

            const contractState = await api.provider(buyerJettonWallet.address).getState();

            if (contractState.state.type !== 'active' || contractState.state.code === null) {
                ui.write('This jetton wallet contract is not active!');
                return;
            } else {
                const stateCode = Cell.fromBoc(contractState.state.code!)[0];

                const jwalletCode = await escrowContract.getEscrowInfo();

                if (!stateCode.equals(jwalletCode.jettonWalletCode!)) {
                    ui.write('Jetton wallet contract code differs from the current contract version!\n');
                    ui.write(
                        `Use the same jetton as https://github.com/ton-blockchain/token-contract/blob/main/ft/jetton-wallet.fc or change escrow init state`,
                    );

                    return;
                }
            }

            await buyerJettonWallet.sendTransfer(
                provider.sender(),
                toNano('0.1'),
                BigInt(info.dealAmount),
                escrowContract.address,
                provider.sender().address!,
                null as unknown as Cell,
                toNano('0.05'),
                null as unknown as Cell,
            );
        } catch (e) {
            ui.write(`Couldn't fund jetton...`);
            return;
        }
    }

    const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 20);

    if (transDone) {
        const escrowInfo = await escrowContract.getEscrowInfo();

        if (escrowInfo.isFunded) {
            ui.write(`Funded successfully!`);
        } else {
            ui.write(`Couldn't fund the deal...`);
        }
    } else {
        ui.write(`Couldn't fund the deal...`);
    }
};

const changeWalletCodeAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const isApproveSure = await promptBool('Are you sure you want to change wallet code?', ['Yes', 'No'], ui);

    if (!isApproveSure) {
        return;
    }

    const api = provider.api();

    const lastTransaction = (await api.provider(escrowContract.address).getState()).last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    const newJWalletCode = await promptCell('Please enter new jetton wallet code cell (base64)', ui);

    await escrowContract.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        {
            $$type: 'UpdateJettonWalletCode',
            newJettonWalletCode: newJWalletCode!,
        },
    );

    const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 20);

    if (transDone) {
        const data = await escrowContract.getEscrowInfo();

        if (data.jettonWalletCode?.equals(newJWalletCode!)) {
            ui.write(`Changed wallet code successfully!`);
        } else {
            ui.write(`Couldn't change wallet code...`);
        }
    } else {
        ui.write(`Couldn't change wallet code...`);
    }
};

const approveDealAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const isApproveSure = await promptBool('Are you sure you want to approve deal?', ['Yes', 'No'], ui);

    if (!isApproveSure) {
        return;
    }

    const api = provider.api();

    const lastTransaction = (await api.provider(escrowContract.address).getState()).last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    await escrowContract.send(
        provider.sender(),
        {
            value: toNano('0.11'),
        },
        'approve',
    );

    // since we are destroying contract on success, any catch is positive cause contract stoped existing
    try {
        const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 20);

        if (transDone) {
            const contractState = await api.provider(escrowContract.address).getState();

            if (contractState.state.type === 'uninit') {
                ui.write(`Approved deal successfully!`);
                process.exit(0);
            } else {
                ui.write(`Couldn't approve the deal...`);
            }
        } else {
            ui.write(`Couldn't approve the deal...`);
        }
    } catch (e) {
        ui.write(`Approved deal successfully!`);
        process.exit(0);
    }
};

const cancelDealAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const isCancelSure = await promptBool('Are you sure you want to cancel deal?', ['Yes', 'No'], ui);

    if (!isCancelSure) {
        return;
    }

    const api = provider.api();

    const lastTransaction = (await api.provider(escrowContract.address).getState()).last;

    if (lastTransaction === null) throw "Last transaction can't be null on deployed contract";

    await escrowContract.send(
        provider.sender(),
        {
            value: toNano('0.11'),
        },
        'cancel',
    );

    try {
        const transDone = await waitForTransaction(provider, escrowContract.address, lastTransaction.lt, 20);

        if (transDone) {
            const contractState = await api.provider(escrowContract.address).getState();

            if (contractState.state.type === 'uninit') {
                ui.write(`Cancelled deal successfully!`);
                process.exit(0);
            } else {
                ui.write(`Couldn't cancel the deal...`);
            }
        } else {
            ui.write(`Couldn't cancel the deal...`);
        }
    } catch (e) {
        ui.write(`Cancelled deal successfully!`);
        process.exit(0);
    }
};

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const hasSender = sender.address !== undefined;
    const api = provider.api();

    let done = false;
    let retry: boolean;
    let escrowAddress: Address;

    do {
        retry = false;
        const action = await ui.choose('Pick action:', contractActions, (c) => c);

        switch (action) {
            case 'Create new escrow deal':
                const ctxId = await promptNumber('Enter escrow id', ui);
                const dealAmount = await promptAmount('Enter deal amount (e.g. 1.25, without nano)', ui);
                const sellerAddress = await promptAddress('Enter seller address:', ui);
                const guarantorAddress = await promptAddress('Enter guarantor address:', ui);
                // need to multiply by 1000
                const royaltyAmount = await promptAmount(
                    'Enter guarantor royalty amount (percent, up to 3 floating point digits, e.g. 20.25)',
                    ui,
                );

                // true == ton
                const isAssetTON = await promptBool('What is the deal asset type?', ['TON', 'Jetton'], ui, true);
                let assetAddress: Maybe<Address> = null;
                let jcodeCell: Maybe<Cell> = null;

                if (!isAssetTON) {
                    ui.write(
                        `Current deployment would be using https://github.com/ton-blockchain/token-contract/blob/main/ft/jetton-wallet.fc as jetton wallet code`,
                    );
                    assetAddress = await promptAddress('Enter asset jetton address (minter address):', ui);
                    jcodeCell = await compile('ft/JettonWallet');
                }

                const royalty = Number(Number(royaltyAmount).toFixed(3)) * 1000;

                const escrow = provider.open(
                    await Escrow.fromInit(
                        BigInt(ctxId),
                        sellerAddress,
                        guarantorAddress,
                        toNano(dealAmount),
                        BigInt(royalty),
                        assetAddress,
                        jcodeCell,
                    ),
                );

                await escrow.send(
                    sender,
                    {
                        value: toNano('0.05'),
                    },
                    {
                        $$type: 'Deploy',
                        queryId: 0n,
                    },
                );

                await provider.waitForDeploy(escrow.address);

                ui.write(`Escrow contract deployed at ${escrow.address.toString({ urlSafe: true })}`);
                escrowAddress = escrow.address;

                break;
            case 'Choose existing escrow deal':
                escrowAddress = await promptAddress('Please enter escrow address:', ui);
                const contractState = await api.provider(escrowAddress).getState();

                if (contractState.state.type !== 'active' || contractState.state.code === null) {
                    retry = true;
                    ui.write('This escrow contract is not active!\nPlease use another address, or deploy it first');
                }
                break;
        }
    } while (retry);

    // escrow address is filled
    escrowContract = provider.open(Escrow.fromAddress(escrowAddress!));
    const escrowData = await escrowContract.getEscrowInfo();

    const isGuarantor = hasSender ? escrowData.guarantorAddress.equals(sender.address) : true;
    const isFunded = escrowData.isFunded;

    let actions = [...generalActions];

    if (isGuarantor) {
        ui.write(`Current sender (if present) is escrow guarantor!`);
        actions = [...actions, ...guarantorActions];
    }
    if (!isFunded) {
        ui.write(`Current escrow deal wasn't funded yet!`);
        actions = [...actions, ...buyerActions];
    }

    do {
        const action = await ui.choose('Pick action:', actions, (c) => c);

        switch (action) {
            case 'Get status':
                await getStatusDeal(provider, ui);
                break;
            case 'Get info':
                await getInfo(provider, ui);
                break;
            case 'Get royalty':
                await getRoyalty(provider, ui);
                break;
            case 'Approve deal':
                await approveDealAction(provider, ui);
                break;
            case 'Change wallet code':
                await changeWalletCodeAction(provider, ui);
                break;
            case 'Fund':
                await fundingAction(provider, ui);
                break;
            case 'Cancel deal':
                await cancelDealAction(provider, ui);
                break;
            case 'Quit':
                done = true;
                break;
        }
    } while (!done);
}
