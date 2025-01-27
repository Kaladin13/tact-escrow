import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { Escrow } from '../wrappers/Escrow';
import '@ton/test-utils';
import { JettonWallet } from '../wrappers/ft/JettonWallet';
import { compile } from '@ton/blueprint';
import { jettonContentToCell, JettonMinter } from '../wrappers/ft/JettonMinter';
import { Op } from '../wrappers/ft/JettonConstants';

const SECONDS = 1000;
jest.setTimeout(70 * SECONDS);

describe('Escrow', () => {
    // jettons
    let minterJettonCode: Cell;
    let jwalletCode: Cell;
    let defaultContent: Cell;
    let userWallet: (a: Address) => Promise<SandboxContract<JettonWallet>>;

    beforeAll(async () => {
        jwalletCode = await compile('ft/JettonWallet');
        minterJettonCode = await compile('ft/JettonMinter');

        defaultContent = jettonContentToCell({ type: 1, uri: 'https://testjetton.org/content.json' });
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;

    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let guarantor: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;
    let lastCtxId = 1n;

    const generateEscrowContract = async (assetAddress: Address | null, dealAmount: bigint, royalty: bigint) => {
        return blockchain.openContract(
            await Escrow.fromInit(
                lastCtxId++,
                seller.address,
                guarantor.address,
                dealAmount,
                royalty,
                assetAddress,
                assetAddress ? jwalletCode : null,
            ),
        );
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        seller = await blockchain.treasury('seller');
        buyer = await blockchain.treasury('buyer');
        guarantor = await blockchain.treasury('guarantor');

        // jettons setup
        jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: deployer.address,
                    content: defaultContent,
                    wallet_code: jwalletCode,
                },
                minterJettonCode,
            ),
        );
        userWallet = async (address: Address) =>
            blockchain.openContract(JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(address)));

        await jettonMinter.sendDeploy(deployer.getSender(), toNano('100'));
        await jettonMinter.sendMint(deployer.getSender(), buyer.address, toNano(100), toNano('0.05'), toNano('1'));
    });

    // ton tests
    it('should deploy with correct state ton flow', async () => {
        const escrowContract = await generateEscrowContract(null, 100n, 1n);

        const deployResult = await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.assetAddress).toBeNull();
        expect(data.dealAmount).toBe(100n);
        expect(data.guarantorRoyaltyPercent).toBe(1n);
        expect(data.guarantorAddress).toEqualAddress(guarantor.address);
        expect(data.sellerAddress).toEqualAddress(seller.address);
        expect(data.jettonWalletCode).toBeNull();
        expect(data.buyerAddress).toBeNull();
    });

    it('should accept correct ton funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const fundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        expect(fundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.buyerAddress).toEqualAddress(buyer.address);
        expect(data.isFunded).toBeTruthy();
    });

    it('should reject wrong ton amount', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const maliciousFundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount - 1n,
            },
            'funding',
        );

        expect(maliciousFundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount - 1n,
            success: false,
            exitCode: 15301, // wrong fund amount
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.buyerAddress).toBeNull();
        expect(data.isFunded).toBeFalsy();
    });

    it('should reject double funding ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        // succesfully funded
        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const secondFundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        expect(secondFundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount,
            success: false,
            exitCode: 33704, // already funded
        });
    });

    it('should reject incorrect asset funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        // set asset address as jetton, try to fund with ton
        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const fundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        expect(fundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount,
            success: false,
            exitCode: 52368, // wrong asset type
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.isFunded).toBeFalsy();
    });

    it('should correctly calculate guarantor royalties', async () => {
        const dealAmount = toNano(10); // 10 ton
        const guarantorRoyaltyPercent = 5_000n; // 5%

        const escrowContract = await generateEscrowContract(null, dealAmount, guarantorRoyaltyPercent);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const guarantorRoyalty = (dealAmount * guarantorRoyaltyPercent) / 100_000n;

        const royalty = await escrowContract.getCalculateRoyaltyAmount();

        expect(royalty).toBe(guarantorRoyalty);
        expect(royalty).toBe(toNano(0.5)); // 10 * 5% = 0.5
    });

    it('should reject code update within ton escrow', async () => {
        const dealAmount = toNano(5); // 5 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const newJwalletCode = beginCell().storeAddress(seller.address).endCell();

        const updateResult = await escrowContract.send(
            seller.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'UpdateJettonWalletCode',
                newJettonWalletCode: newJwalletCode, // example cell
            },
        );

        expect(updateResult.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            success: false,
            exitCode: 52368, // wrong asset type
        });
    });

    it('should reject guarantor-only actions from non-guarantor', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const maliciousCancelResult = await escrowContract.send(
            seller.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(maliciousCancelResult.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            success: false,
            exitCode: 21150, // not guarantor
        });

        const maliciousApproveResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: toNano('0.05'),
            },
            'approve',
        );

        expect(maliciousApproveResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            success: false,
            exitCode: 21150, // not guarantor
        });
    });

    it('should reject guarantor-only actions before funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const maliciousCancelResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(maliciousCancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: false,
            exitCode: 14215, // not funded
        });

        const maliciousApproveResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'approve',
        );

        expect(maliciousApproveResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: false,
            exitCode: 14215, // not funded
        });
    });

    it('should allow guarantor to cancel the deal with ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const cancelResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(cancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: true,
            endStatus: 'non-existing', // escrow should be destroyed after cancel
        });

        expect(cancelResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: buyer.address,
            value: (v) => v! >= dealAmount && v! <= dealAmount + toNano(1), // in-between check cause 128+32 send mode
            success: true,
        });
    });

    // jetton tests
    it('should deploy with correct state jetton', async () => {
        const escrowContract = await generateEscrowContract(jettonMinter.address, 100n, 1n);

        const deployResult = await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.assetAddress).toEqualAddress(jettonMinter.address);
        expect(data.dealAmount).toBe(100n);
        expect(data.guarantorRoyaltyPercent).toBe(1n);
        expect(data.guarantorAddress).toEqualAddress(guarantor.address);
        expect(data.sellerAddress).toEqualAddress(seller.address);
        expect(data.jettonWalletCode).toEqualCell(jwalletCode);
        expect(data.buyerAddress).toBeNull();
    });

    it('should accept jetton correct funding', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const buyerJettonWallet = await userWallet(buyer.address);

        const jettonFundingResult = await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        expect(jettonFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: Op.transfer_notification,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.buyerAddress).toEqualAddress(buyer.address);
        expect(data.isFunded).toBeTruthy();
    });

    it('should reject incorrect jetton amount', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const buyerJettonWallet = await userWallet(buyer.address);

        const jettonFundingResult = await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount - 1n,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        expect(jettonFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: Op.transfer_notification,
            success: false,
            exitCode: 15301, // wrong fund amount
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.isFunded).toBeFalsy();
    });

    it('should reject jetton funding from malicious account', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        // malicious jetton buy attempt
        const maliciousFundingResult = await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell()
                .storeUint(Op.transfer_notification, 32)
                .storeUint(0, 64)
                .storeCoins(dealAmount)
                .storeAddress(buyer.address)
                .storeSlice(beginCell().endCell().asSlice())
                .endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        expect(maliciousFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            success: false,
            exitCode: 37726, // notification not from escrow jetton wallet
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.isFunded).toBeFalsy();
    });

    it('should reject jetton funding from another jetton', async () => {
        const dealAmount = toNano(5); // 5 jetton

        // we can use seller address as asset address, doesn't affect the test
        const escrowContract = await generateEscrowContract(seller.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const buyerJettonWallet = await userWallet(buyer.address);

        const wrongJettonFundingResult = await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        expect(wrongJettonFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: Op.transfer_notification,
            success: false,
            exitCode: 37726, // notification not from escrow jetton wallet
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.isFunded).toBeFalsy();
    });

    it('should correctly updade jetton wallet code', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const newJwalletCode = beginCell().storeAddress(seller.address).endCell();

        const updateResult = await escrowContract.send(
            seller.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'UpdateJettonWalletCode',
                newJettonWalletCode: newJwalletCode, // example cell
            },
        );

        expect(updateResult.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.jettonWalletCode).toEqualCell(newJwalletCode);
    });

    // we prohibit this logic because malicious seller can update jetton wallet code after funding
    // which can lead to jetton loss in the refund scenario
    it('should reject code update after funding', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const buyerJettonWallet = await userWallet(buyer.address);

        await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        const newJwalletCode = beginCell().storeAddress(seller.address).endCell();

        const updateResult = await escrowContract.send(
            seller.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'UpdateJettonWalletCode',
                newJettonWalletCode: newJwalletCode, // example cell
            },
        );

        expect(updateResult.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            success: false,
            exitCode: 33704, // already funded
        });
    });

    it('should allow guarantor to cancel the deal with jetton', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowContract = await generateEscrowContract(jettonMinter.address, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const buyerJettonWallet = await userWallet(buyer.address);

        await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        const buyerJettonBalanceBefore = await buyerJettonWallet.getJettonBalance();

        const cancelResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(cancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: true,
            endStatus: 'non-existing', // escrow should be destroyed after cancel
        });

        const buyerJettonBalanceAfter = await buyerJettonWallet.getJettonBalance();

        // internal transfer from escrow to buyer
        expect(cancelResult.transactions).toHaveTransaction({
            to: buyerJettonWallet.address,
            success: true,
        });

        expect(buyerJettonBalanceBefore).toEqual(buyerJettonBalanceAfter - dealAmount);
    });
});
